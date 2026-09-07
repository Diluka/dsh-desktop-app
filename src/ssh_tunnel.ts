import type { Logger } from "pino";
import { loopbackDshWebUrl } from "./dsh_web.ts";
import {
  isCommandNotFoundError,
  type ManagedHiddenProcess,
  readProcessOutputTail,
  runHiddenCommand,
} from "./hidden_process.ts";
import { allocateLoopbackPort } from "./loopback_http.ts";
import { ManagedEndpoint, type ManagedEndpointExit } from "./managed_endpoint.ts";
import type { ServerProfile } from "./profiles.ts";

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

export interface StartTunnelOptions {
  readonly command?: string;
  readonly allocatePort?: () => Promise<number>;
  readonly spawn: (command: string, args: string[]) => ManagedHiddenProcess;
  readonly delay?: (milliseconds: number) => Promise<void>;
}

export type TunnelExit = ManagedEndpointExit;

export class SshTunnel extends ManagedEndpoint {
  #running = true;

  constructor(
    private readonly profile: ServerProfile,
    readonly localPort: number,
    child: ManagedHiddenProcess,
    delay: (milliseconds: number) => Promise<void>,
  ) {
    super(loopbackDshWebUrl(localPort, profile.dshWebToken), child, delay);
    void this.exited.then(() => this.#running = false);
  }

  matches(profile: ServerProfile): boolean {
    return this.#running && this.profile.id === profile.id &&
      this.profile.sshTarget === profile.sshTarget &&
      this.profile.remotePort === profile.remotePort;
  }

  override stop(): Promise<void> {
    this.#running = false;
    return super.stop();
  }

  useDshWebToken(token: string): void {
    this.replaceUrl(loopbackDshWebUrl(this.localPort, token));
  }

  async failureFromExit(exit: TunnelExit, logger: Logger): Promise<TunnelError> {
    const detail = await readProcessOutputTail(this.outputFile);
    const error = classifySshFailure(detail, exit.error);
    logger.warn({
      event: "ssh.tunnel_failed",
      profileId: this.profile.id,
      errorCode: error.code,
      childExitCode: exit.code,
      childSignal: exit.signal,
      childOutputFile: this.outputFile,
      ...(exit.error ? { err: exit.error } : {}),
    }, "OpenSSH tunnel failed");
    return error;
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
  const command = options.command ?? "ssh";
  const allocatePort = options.allocatePort ?? allocateLoopbackPort;
  const delay = options.delay ?? sleep;
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
    child = options.spawn(command, args);
  } catch (error) {
    if (isCommandNotFoundError(error)) {
      throw new TunnelError("SSH_NOT_FOUND", "未找到 OpenSSH Client，请先安装后重试");
    }
    throw error;
  }
  return new SshTunnel(profile, localPort, child, delay);
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
