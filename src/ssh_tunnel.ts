import type { Logger } from "pino";
import {
  isCommandNotFoundError,
  type ManagedHiddenProcess,
  readProcessOutputTail,
  runHiddenCommand,
} from "./hidden_process.ts";
import { allocateLoopbackPort, probeHttp } from "./loopback_http.ts";
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
  | "DSH_UNAVAILABLE"
  | "SSH_FAILED";

export class TunnelError extends Error {
  override name = "TunnelError";

  constructor(readonly code: TunnelErrorCode, message: string) {
    super(message);
  }
}

interface StartTunnelOptions {
  readonly command?: string;
  readonly startupTimeoutMs?: number;
  readonly allocatePort?: () => Promise<number>;
  readonly spawn: (command: string, args: string[]) => ManagedHiddenProcess;
  readonly probe?: (url: string) => Promise<void>;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

export interface TunnelExit {
  readonly success: boolean;
  readonly code: number;
  readonly signal: string | null;
  readonly error?: Error;
  readonly stopRequested: boolean;
}

export class SshTunnel {
  readonly exited: Promise<TunnelExit>;
  #finished = false;
  #stopRequested = false;

  readonly outputFile: string;

  constructor(
    readonly url: string,
    private readonly child: ManagedHiddenProcess,
    private readonly delay: (milliseconds: number) => Promise<void>,
  ) {
    this.outputFile = child.outputFile;
    this.exited = (async () => {
      const status = await child.status;
      this.#finished = true;
      return {
        ...status,
        stopRequested: this.#stopRequested,
      };
    })();
  }

  async stop(): Promise<void> {
    if (this.#finished) return;
    this.#stopRequested = true;
    try {
      this.child.kill("SIGTERM");
    } catch {
      return;
    }

    await Promise.race([this.exited.then(() => undefined), this.delay(2_000)]);
    if (this.#finished) return;
    try {
      this.child.kill("SIGKILL");
    } catch {
      // The process may have exited between the status check and kill.
    }
    await this.exited.catch(() => undefined);
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
    try {
      return await startTunnelAttempt(profile, logger, options);
    } catch (error) {
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
  const probe = options.probe ?? probeHttp;
  const delay = options.delay ?? sleep;
  const now = options.now ?? Date.now;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const localPort = await allocatePort();
  const args = buildSshArguments(profile, localPort);

  logger.info({
    event: "ssh.tunnel_starting",
    profileId: profile.id,
    sshTarget: profile.sshTarget,
    remotePort: profile.remotePort,
  }, "Starting OpenSSH local port forwarding");

  let child: ManagedHiddenProcess;
  try {
    child = spawn(command, args);
  } catch (error) {
    if (isCommandNotFoundError(error)) {
      throw new TunnelError("SSH_NOT_FOUND", "未找到 OpenSSH Client，请先安装后重试");
    }
    throw error;
  }

  const tunnel = new SshTunnel(`http://127.0.0.1:${localPort}/`, child, delay);
  const exitOutcome = tunnel.exited.then((value) => ({
    kind: "exit" as const,
    value,
  }));

  async function failureFromExit(exit: TunnelExit): Promise<TunnelError> {
    const detail = await readProcessOutputTail(tunnel.outputFile);
    const error = classifySshFailure(detail, exit.error);
    logger.warn({
      event: "ssh.tunnel_failed",
      profileId: profile.id,
      errorCode: error.code,
      childExitCode: exit.code,
      childSignal: exit.signal,
      childOutputFile: tunnel.outputFile,
      ...(exit.error ? { err: exit.error } : {}),
    }, "OpenSSH tunnel failed");
    return error;
  }

  const startedAt = now();
  while (now() - startedAt < startupTimeoutMs) {
    const outcome = await Promise.race([
      exitOutcome,
      probe(tunnel.url).then(
        () => ({ kind: "ready" as const }),
        () => ({ kind: "retry" as const }),
      ),
    ]);
    if (outcome.kind === "exit") throw await failureFromExit(outcome.value);
    if (outcome.kind === "ready") {
      logger.info({
        event: "ssh.tunnel_ready",
        profileId: profile.id,
        childOutputFile: tunnel.outputFile,
        startupMs: Math.max(0, now() - startedAt),
      }, "SSH tunnel and remote DSH Web are ready");
      return tunnel;
    }

    const pause = await Promise.race([
      exitOutcome,
      delay(150).then(() => ({ kind: "retry" as const })),
    ]);
    if (pause.kind === "exit") throw await failureFromExit(pause.value);
  }

  await tunnel.stop();
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

function classifySshFailure(detail: string, processError?: Error): TunnelError {
  if (
    /address already in use|cannot listen to port|could not request local forwarding/iu.test(detail)
  ) {
    return new TunnelError("LOCAL_PORT_BUSY", "本地端口刚被其他程序占用，正在重试");
  }
  if (isCommandNotFoundError(processError) || /\bENOENT\b|not found/iu.test(detail)) {
    return new TunnelError("SSH_NOT_FOUND", "未找到 OpenSSH Client，请先安装后重试");
  }
  if (/permission denied|no more authentication methods/iu.test(detail)) {
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
