import type { Logger } from "pino";
import { loopbackDshWebUrl } from "./dsh_web.ts";
import {
  isCommandNotFoundError,
  type ManagedHiddenProcess,
  readProcessOutputTail,
  runHiddenCommand,
} from "./hidden_process.ts";
import { allocateLoopbackPort, probeHttp } from "./loopback_http.ts";
import { ManagedEndpoint, type ManagedEndpointExit } from "./managed_endpoint.ts";
import type { ServerProfile } from "./profiles.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const MAX_LOCAL_PORT_ATTEMPTS = 3;

export interface OpenSshInfo {
  readonly available: boolean;
  readonly version?: string;
  readonly installHelp?: string;
}

export type TunnelErrorCode =
  | "SSH_NOT_FOUND"
  | "AUTH_FAILED"
  | "HOST_KEY_FAILED"
  | "HOST_NOT_FOUND"
  | "CONNECTION_FAILED"
  | "LOCAL_PORT_BUSY"
  | "DSH_LOGIN_REQUIRED"
  | "DSH_UNAVAILABLE"
  | "SSH_FAILED";

export class TunnelError extends Error {
  override name = "TunnelError";

  constructor(readonly code: TunnelErrorCode, message: string) {
    super(message);
  }
}

export interface DshWebTokenRecoveryContext {
  readonly profile: ServerProfile;
  readonly localPort: number;
  readonly currentUrl: string;
}

export interface RecoveredDshWebToken {
  readonly token: string;
  readonly sourceId?: string;
}

interface StartTunnelOptions {
  readonly signal?: AbortSignal;
  readonly command?: string;
  readonly startupTimeoutMs?: number;
  readonly allocatePort?: () => Promise<number>;
  readonly spawn: (command: string, args: string[]) => ManagedHiddenProcess;
  readonly probe?: (url: string) => Promise<number>;
  readonly recoverToken?: (
    context: DshWebTokenRecoveryContext,
  ) => Promise<RecoveredDshWebToken | undefined>;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

export type TunnelExit = ManagedEndpointExit;

export class SshTunnel extends ManagedEndpoint {
  useDshWebToken(localPort: number, token: string): void {
    this.replaceUrl(loopbackDshWebUrl(localPort, token));
  }
}

export async function probeOpenSsh(
  os: typeof Deno.build.os = Deno.build.os,
  command = "ssh",
): Promise<OpenSshInfo> {
  try {
    const output = await runHiddenCommand(command, ["-V"]);
    const text = `${output.stderr} ${output.stdout}`.trim();
    const version = text.match(/OpenSSH[^\s,]*/u)?.[0] ?? text.split(/\s/u)[0];
    return { available: output.success, ...(version ? { version } : {}) };
  } catch (error) {
    if (!isCommandNotFoundError(error)) throw error;
    return {
      available: false,
      installHelp: os === "windows"
        ? "请在 Windows 设置的可选功能中安装 OpenSSH 客户端，然后重新启动应用。"
        : os === "darwin"
        ? "请安装 OpenSSH Client，并确认 ssh 可从 macOS PATH 启动。"
        : "请安装 OpenSSH Client；Debian/Ubuntu 可执行 sudo apt install openssh-client。",
    };
  }
}

export function buildSshArguments(profile: ServerProfile, localPort: number): string[] {
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw new TunnelError("LOCAL_PORT_BUSY", "无法分配本地端口，请重试");
  }

  return [
    "-N",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ConnectTimeout=12",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-L",
    `127.0.0.1:${localPort}:127.0.0.1:${profile.remotePort}`,
    "--",
    profile.sshTarget,
  ];
}

export async function startSshTunnel(
  profile: ServerProfile,
  logger: Logger,
  options: StartTunnelOptions,
): Promise<SshTunnel> {
  for (let attempt = 1; attempt <= MAX_LOCAL_PORT_ATTEMPTS; attempt++) {
    throwIfAborted(options.signal);
    try {
      const tunnel = await startTunnelAttempt(profile, logger, options);
      if (options.signal?.aborted) {
        await tunnel.stop();
        throwIfAborted(options.signal);
      }
      return tunnel;
    } catch (error) {
      throwIfAborted(options.signal);
      if (!(error instanceof TunnelError) || error.code !== "LOCAL_PORT_BUSY") throw error;
      logger.warn({
        event: "ssh.local_port_retry",
        profileId: profile.id,
        attempt,
      }, "Local port was claimed before SSH bound it");
    }
  }
  throw new TunnelError("LOCAL_PORT_BUSY", "无法分配本地端口，请重试");
}

async function startTunnelAttempt(
  profile: ServerProfile,
  logger: Logger,
  options: StartTunnelOptions,
): Promise<SshTunnel> {
  const command = options.command ?? "ssh";
  const allocatePort = options.allocatePort ?? allocateLoopbackPort;
  const spawn = options.spawn;
  const probe = options.probe ?? ((url) =>
    probeHttp(url, {
      signal: options.signal,
      accept: "text/html",
      validateStatus: () => true,
    }));
  const delay = options.delay ?? sleep;
  const now = options.now ?? Date.now;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const signal = options.signal;
  const localPort = await waitForStartup(allocatePort, signal);
  throwIfAborted(signal);
  const args = buildSshArguments(profile, localPort);
  const url = loopbackDshWebUrl(localPort, profile.dshWebToken);

  logger.info({
    event: "ssh.tunnel_starting",
    profileId: profile.id,
    sshTarget: profile.sshTarget,
    remotePort: profile.remotePort,
  }, "Starting OpenSSH local port forwarding");

  let child: ManagedHiddenProcess;
  try {
    throwIfAborted(signal);
    child = spawn(command, args);
  } catch (error) {
    if (isCommandNotFoundError(error)) {
      throw new TunnelError("SSH_NOT_FOUND", "未找到 OpenSSH Client，请先安装后重试");
    }
    throw error;
  }

  let tunnel: SshTunnel | undefined;
  try {
    tunnel = new SshTunnel(url, child, delay);
    return await waitUntilReady(tunnel);
  } catch (error) {
    try {
      if (tunnel) await tunnel.stop();
      else child.kill("SIGKILL");
    } catch {
      // A failing injected delay must not leave the startup child running.
      try {
        child.kill("SIGKILL");
      } catch {
        // It may already have exited.
      }
    }
    await child.status.catch(() => undefined);
    throwIfAborted(signal);
    throw error;
  }

  async function waitUntilReady(tunnel: SshTunnel): Promise<SshTunnel> {
    throwIfAborted(signal);
    let tokenRecoveryAttempted = false;
    const exitOutcome = tunnel.exited.then((value) => ({
      kind: "exit" as const,
      value,
    }));

    async function failureFromExit(exit: TunnelExit): Promise<TunnelError> {
      const detail = await waitForStartup(() => readProcessOutputTail(tunnel.outputFile), signal);
      const error = classifySshFailure(detail, exit.error);
      logger.warn({
        event: "ssh.tunnel_failed",
        profileId: profile.id,
        errorCode: error.code,
        childExitCode: exit.code,
        childSignal: exit.signal,
        childOutputFile: tunnel.outputFile,
      }, "OpenSSH tunnel failed");
      return error;
    }

    const startedAt = now();
    while (now() - startedAt < startupTimeoutMs) {
      const outcome = await waitForStartup(() =>
        Promise.race([
          exitOutcome,
          probe(tunnel.url).then(
            (status) => probeOutcome(status),
            () => ({ kind: "retry" as const }),
          ),
        ]), signal);
      throwIfAborted(signal);
      if (outcome.kind === "exit") throw await failureFromExit(outcome.value);
      if (outcome.kind === "login_required") {
        if (!tokenRecoveryAttempted && options.recoverToken) {
          tokenRecoveryAttempted = true;
          try {
            throwIfAborted(signal);
            // The recovery callback owns another SSH process. Await its cleanup
            // instead of racing cancellation and leaving that process behind.
            const recovered = await options.recoverToken({
              profile,
              localPort,
              currentUrl: tunnel.url,
            });
            throwIfAborted(signal);
            if (recovered) {
              tunnel.useDshWebToken(localPort, recovered.token);
              logger.info({
                event: "ssh.dsh_token_recovered",
                profileId: profile.id,
                childOutputFile: tunnel.outputFile,
                startupMs: Math.max(0, now() - startedAt),
                sourceId: recovered.sourceId ?? "unknown",
              }, "Recovered remote DSH Web launch token");
              return tunnel;
            }
          } catch (error) {
            throwIfAborted(signal);
            logger.warn({
              event: "ssh.dsh_token_recovery_failed",
              profileId: profile.id,
              errorCode: error instanceof TunnelError ? error.code : "UNKNOWN",
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
        return tunnel;
      }

      const pause = await waitForStartup(() =>
        Promise.race([
          exitOutcome,
          (options.delay ? delay(150) : sleep(150, signal)).then(() => ({
            kind: "retry" as const,
          })),
        ]), signal);
      if (pause.kind === "exit") throw await failureFromExit(pause.value);
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
}

function probeOutcome(status: number):
  | { readonly kind: "ready" }
  | { readonly kind: "login_required"; readonly status: number }
  | { readonly kind: "retry" } {
  if (status === 401) return { kind: "login_required", status };
  if (status >= 200 && status < 400) return { kind: "ready" };
  return { kind: "retry" };
}

function classifySshFailure(detail: string, processError?: Error): TunnelError {
  if (
    /address already in use|cannot listen to port|could not request local forwarding/iu.test(detail)
  ) {
    return new TunnelError("LOCAL_PORT_BUSY", "本地端口刚被其他程序占用，正在重试");
  }
  if (isCommandNotFoundError(processError) || /\bENOENT\b|not found/iu.test(detail)) {
    return new TunnelError("SSH_NOT_FOUND", "未找到 OpenSSH Client，请先安装后重试");
  }
  if (
    /permission denied|no more authentication methods|too many authentication failures/iu.test(
      detail,
    )
  ) {
    return new TunnelError(
      "AUTH_FAILED",
      "SSH 认证失败；请检查 .ssh/config、密钥和 ssh-agent（首版不支持密码交互）",
    );
  }
  if (/host key verification failed|remote host identification has changed/iu.test(detail)) {
    return new TunnelError(
      "HOST_KEY_FAILED",
      "SSH 主机密钥校验失败；请先在终端确认新主机，或检查 known_hosts",
    );
  }
  if (/could not resolve hostname|name or service not known/iu.test(detail)) {
    return new TunnelError("HOST_NOT_FOUND", "无法解析 SSH Host，请检查 .ssh/config 中的 Host");
  }
  if (
    /connection refused|connection timed out|operation timed out|no route to host/iu.test(detail)
  ) {
    return new TunnelError("CONNECTION_FAILED", "无法连接 SSH 服务器，请检查网络和 SSH 配置");
  }
  return new TunnelError("SSH_FAILED", "OpenSSH 隧道启动失败，详细信息已写入日志");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("SSH startup cancelled", "AbortError");
}

async function waitForStartup<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return await operation();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("SSH startup cancelled", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([
      aborted,
      Promise.resolve().then(() => {
        throwIfAborted(signal);
        return operation();
      }),
    ]);
    throwIfAborted(signal);
    return result;
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("SSH startup cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
