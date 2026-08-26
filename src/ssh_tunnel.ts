import type { JsonlLogger } from "./logger.ts";
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

interface ChildProcessLike {
  readonly status: Promise<Deno.CommandStatus>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(signal?: Deno.Signal): void;
}

interface StartTunnelOptions {
  readonly command?: string;
  readonly startupTimeoutMs?: number;
  readonly allocatePort?: () => Promise<number>;
  readonly spawn?: (command: string, args: string[]) => ChildProcessLike;
  readonly probe?: (url: string) => Promise<void>;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

export interface TunnelExit {
  readonly success: boolean;
  readonly code: number;
  readonly signal: string | null;
  readonly stderr: readonly string[];
  readonly stopRequested: boolean;
}

export class SshTunnel {
  readonly exited: Promise<TunnelExit>;
  #finished = false;
  #stopRequested = false;

  constructor(
    readonly url: string,
    private readonly child: ChildProcessLike,
    private readonly stderrDone: Promise<readonly string[]>,
    private readonly delay: (milliseconds: number) => Promise<void>,
  ) {
    this.exited = (async () => {
      const status = await child.status;
      this.#finished = true;
      return {
        ...status,
        stderr: await stderrDone,
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
    const output = await new Deno.Command(command, {
      args: ["-V"],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = `${new TextDecoder().decode(output.stderr)} ${
      new TextDecoder().decode(output.stdout)
    }`.trim();
    const version = text.match(/OpenSSH[^\s,]*/u)?.[0] ?? text.split(/\s/u)[0];
    return { available: output.success, ...(version ? { version } : {}) };
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return {
      available: false,
      installHelp: os === "windows"
        ? "请在 Windows 设置的可选功能中安装 OpenSSH 客户端，然后重新启动应用。"
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
  logger: JsonlLogger,
  options: StartTunnelOptions = {},
): Promise<SshTunnel> {
  for (let attempt = 1; attempt <= MAX_LOCAL_PORT_ATTEMPTS; attempt++) {
    try {
      return await startTunnelAttempt(profile, logger, options);
    } catch (error) {
      if (!(error instanceof TunnelError) || error.code !== "LOCAL_PORT_BUSY") throw error;
      await logger.warn("ssh.local_port_retry", "Local port was claimed before SSH bound it", {
        profileId: profile.id,
        attempt,
      });
    }
  }
  throw new TunnelError("LOCAL_PORT_BUSY", "无法分配本地端口，请重试");
}

async function startTunnelAttempt(
  profile: ServerProfile,
  logger: JsonlLogger,
  options: StartTunnelOptions,
): Promise<SshTunnel> {
  const command = options.command ?? "ssh";
  const allocatePort = options.allocatePort ?? allocateLoopbackPort;
  const spawn = options.spawn ?? spawnOpenSsh;
  const probe = options.probe ?? probeHttp;
  const delay = options.delay ?? sleep;
  const now = options.now ?? Date.now;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const localPort = await allocatePort();
  const args = buildSshArguments(profile, localPort);

  await logger.info("ssh.tunnel_starting", "Starting OpenSSH local port forwarding", {
    profileId: profile.id,
    sshTarget: profile.sshTarget,
    remotePort: profile.remotePort,
  });

  let child: ChildProcessLike;
  try {
    child = spawn(command, args);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new TunnelError("SSH_NOT_FOUND", "未找到 OpenSSH Client，请先安装后重试");
    }
    throw error;
  }

  const stderr = monitorStderr(child.stderr, (line) => {
    void logger.warn("ssh.stderr", "OpenSSH reported a diagnostic", {
      profileId: profile.id,
      detail: line,
    });
  });
  const tunnel = new SshTunnel(
    `http://127.0.0.1:${localPort}/`,
    child,
    stderr.done,
    delay,
  );
  const exitOutcome = tunnel.exited.then((value) => ({
    kind: "exit" as const,
    value,
  }));

  const startedAt = now();
  while (now() - startedAt < startupTimeoutMs) {
    const outcome = await Promise.race([
      exitOutcome,
      probe(tunnel.url).then(
        () => ({ kind: "ready" as const }),
        () => ({ kind: "retry" as const }),
      ),
    ]);
    if (outcome.kind === "exit") throw classifySshFailure(outcome.value.stderr);
    if (outcome.kind === "ready") {
      await logger.info("ssh.tunnel_ready", "SSH tunnel and remote DSH Web are ready", {
        profileId: profile.id,
        startupMs: Math.max(0, now() - startedAt),
      });
      return tunnel;
    }

    const pause = await Promise.race([
      exitOutcome,
      delay(150).then(() => ({ kind: "retry" as const })),
    ]);
    if (pause.kind === "exit") throw classifySshFailure(pause.value.stderr);
  }

  await tunnel.stop();
  throw new TunnelError(
    "DSH_UNAVAILABLE",
    "SSH 已连接，但远端 DSH Web 未在限定时间内响应；请检查远端端口配置",
  );
}

function spawnOpenSsh(command: string, args: string[]): ChildProcessLike {
  return new Deno.Command(command, {
    args,
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).spawn();
}

function allocateLoopbackPort(): Promise<number> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  try {
    const address = listener.addr as Deno.NetAddr;
    return Promise.resolve(address.port);
  } finally {
    listener.close();
  }
}

async function probeHttp(url: string): Promise<void> {
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(1_500),
  });
  await response.body?.cancel();
}

function monitorStderr(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): { done: Promise<readonly string[]> } {
  const tail: string[] = [];
  let privateKeyBlock = false;
  const done = (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split(/\r?\n/u);
        pending = lines.pop() ?? "";
        for (const line of lines) recordLine(line);
      }
      pending += decoder.decode();
      if (pending) recordLine(pending);
    } finally {
      reader.releaseLock();
    }
    return tail;
  })();

  return { done };

  function recordLine(raw: string): void {
    const beginsPrivateKey = /-----BEGIN [^-\r\n]*PRIVATE KEY-----/iu.test(raw);
    const endsPrivateKey = /-----END [^-\r\n]*PRIVATE KEY-----/iu.test(raw);
    if (privateKeyBlock) {
      if (endsPrivateKey) privateKeyBlock = false;
      return;
    }
    if (beginsPrivateKey) {
      privateKeyBlock = !endsPrivateKey;
      storeLine("[REDACTED PRIVATE KEY MATERIAL]");
      return;
    }

    const line = Array.from(raw)
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code === 9 || (code >= 32 && code !== 127);
      })
      .join("")
      .trim();
    if (line) storeLine(line);
  }

  function storeLine(line: string): void {
    tail.push(line.slice(0, 2_000));
    if (tail.length > 20) tail.shift();
    onLine(line.slice(0, 2_000));
  }
}

function classifySshFailure(stderr: readonly string[]): TunnelError {
  const detail = stderr.join("\n");
  if (
    /address already in use|cannot listen to port|could not request local forwarding/iu.test(detail)
  ) {
    return new TunnelError("LOCAL_PORT_BUSY", "本地端口刚被其他程序占用，正在重试");
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
