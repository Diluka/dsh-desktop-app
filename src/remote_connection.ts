import type { Logger } from "pino";
import { probeHttp } from "./loopback_http.ts";
import type { ServerProfile } from "./profiles.ts";
import { SshTunnel, startSshTunnel, type StartTunnelOptions, TunnelError } from "./ssh_tunnel.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const MAX_LOCAL_PORT_ATTEMPTS = 3;

export interface DshWebTokenRecoveryContext {
  readonly profile: ServerProfile;
  readonly localPort: number;
  readonly currentUrl: string;
}

export interface RecoveredDshWebToken {
  readonly token: string;
  readonly sourceId?: string;
}

interface ConnectRemoteOptions extends StartTunnelOptions {
  readonly tunnel?: SshTunnel;
  readonly onTunnel: (tunnel: SshTunnel) => void;
  readonly signal?: AbortSignal;
  readonly startupTimeoutMs?: number;
  readonly probe?: (url: string) => Promise<number>;
  readonly recoverToken?: (
    context: DshWebTokenRecoveryContext,
  ) => Promise<RecoveredDshWebToken | undefined>;
  readonly now?: () => number;
}

// HTTP/login failures leave the registered SSH process owned by the caller.
export async function connectRemoteDsh(
  profile: ServerProfile,
  logger: Logger,
  options: ConnectRemoteOptions,
): Promise<SshTunnel> {
  let tunnel = options.tunnel;
  if (tunnel && !tunnel.matches(profile)) {
    await tunnel.stop();
    tunnel = undefined;
  }
  for (let attempt = 1; attempt <= MAX_LOCAL_PORT_ATTEMPTS; attempt++) {
    options.signal?.throwIfAborted();
    try {
      if (!tunnel) {
        tunnel = await startSshTunnel(profile, logger, options);
        // Shutdown may have happened while allocating the local port.
        if (options.signal?.aborted) {
          await tunnel.stop();
          options.signal.throwIfAborted();
        }
        options.onTunnel(tunnel);
      }
      tunnel.useDshWebToken(profile.dshWebToken);
      await waitForRemoteDsh(tunnel, profile, logger, options);
      options.signal?.throwIfAborted();
      if (!tunnel.matches(profile)) throw await tunnel.failureFromExit(await tunnel.exited, logger);
      return tunnel;
    } catch (error) {
      if (!(error instanceof TunnelError) || error.code !== "LOCAL_PORT_BUSY") throw error;
      tunnel = undefined;
      logger.warn({
        event: "ssh.local_port_retry",
        profileId: profile.id,
        attempt,
      }, "Local port was claimed before SSH bound it");
    }
  }
  throw new TunnelError("LOCAL_PORT_BUSY", "无法分配本地端口，请重试");
}

async function waitForRemoteDsh(
  tunnel: SshTunnel,
  profile: ServerProfile,
  logger: Logger,
  options: ConnectRemoteOptions,
): Promise<void> {
  const probe = options.probe ?? ((url) =>
    probeHttp(url, {
      accept: "text/html",
      validateStatus: () => true,
    }));
  const delay = options.delay ?? sleep;
  const now = options.now ?? Date.now;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  let tokenRecoveryAttempted = false;
  const exitOutcome = tunnel.exited.then((value) => ({
    kind: "exit" as const,
    value,
  }));

  const startedAt = now();
  while (now() - startedAt < startupTimeoutMs) {
    options.signal?.throwIfAborted();
    const outcome = await Promise.race([
      exitOutcome,
      probe(tunnel.url).then(
        (status) => probeOutcome(status),
        () => ({ kind: "retry" as const }),
      ),
    ]);
    options.signal?.throwIfAborted();
    if (outcome.kind === "exit") throw await tunnel.failureFromExit(outcome.value, logger);
    if (outcome.kind === "login_required") {
      if (!tokenRecoveryAttempted && options.recoverToken) {
        tokenRecoveryAttempted = true;
        try {
          const recovered = await options.recoverToken({
            profile,
            localPort: tunnel.localPort,
            currentUrl: tunnel.url,
          });
          if (recovered) {
            tunnel.useDshWebToken(recovered.token);
            logger.info({
              event: "ssh.dsh_token_recovered",
              profileId: profile.id,
              childOutputFile: tunnel.outputFile,
              startupMs: Math.max(0, now() - startedAt),
              sourceId: recovered.sourceId ?? "unknown",
            }, "Recovered remote DSH Web launch token");
            return;
          }
        } catch (error) {
          logger.warn({
            event: "ssh.dsh_token_recovery_failed",
            profileId: profile.id,
            err: error,
          }, "Remote DSH Web token recovery failed");
        }
      }
      logger.warn({
        event: "ssh.dsh_login_required",
        profileId: profile.id,
        childOutputFile: tunnel.outputFile,
        startupMs: Math.max(0, now() - startedAt),
        status: outcome.status,
      }, "Remote DSH Web requires a launch token");
      throw new TunnelError(
        "DSH_LOGIN_REQUIRED",
        "远端 DSH Web 要求登录，请输入新的 token 后重试",
      );
    }
    if (outcome.kind === "ready") {
      logger.info({
        event: "ssh.tunnel_ready",
        profileId: profile.id,
        childOutputFile: tunnel.outputFile,
        startupMs: Math.max(0, now() - startedAt),
      }, "SSH tunnel and remote DSH Web are ready");
      return;
    }

    const pause = await Promise.race([
      exitOutcome,
      delay(150).then(() => ({ kind: "retry" as const })),
    ]);
    if (pause.kind === "exit") throw await tunnel.failureFromExit(pause.value, logger);
  }

  logger.warn({
    event: "ssh.tunnel_unavailable",
    profileId: profile.id,
    childOutputFile: tunnel.outputFile,
  }, "SSH tunnel did not become ready");
  throw new TunnelError(
    "DSH_UNAVAILABLE",
    "SSH 已连接，但远端 DSH Web 未在限定时间内响应；请检查远端端口配置",
  );
}

function probeOutcome(status: number):
  | { readonly kind: "ready" }
  | { readonly kind: "login_required"; readonly status: number }
  | { readonly kind: "retry" } {
  if (status === 401) return { kind: "login_required", status };
  if (status >= 200 && status < 400) return { kind: "ready" };
  return { kind: "retry" };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
