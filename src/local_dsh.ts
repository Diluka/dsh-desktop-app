import type { Logger } from "pino";
import {
  drainProcessStderr,
  isCommandNotFoundError,
  spawnHiddenProcess,
} from "./hidden_process.ts";
import { allocateLoopbackPort, probeHttp } from "./loopback_http.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const MAX_LOCAL_PORT_ATTEMPTS = 3;

export type LocalDshErrorCode =
  | "DSH_NOT_FOUND"
  | "LOCAL_PORT_BUSY"
  | "DSH_WEB_UNAVAILABLE"
  | "DSH_WEB_FAILED";

export class LocalDshError extends Error {
  override name = "LocalDshError";

  constructor(readonly code: LocalDshErrorCode, message: string) {
    super(message);
  }
}

interface ChildProcessLike {
  readonly status: Promise<{ success: boolean; code: number; signal: string | null }>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(signal?: Deno.Signal): void;
}

interface StartLocalDshOptions {
  readonly command?: string;
  readonly startupTimeoutMs?: number;
  readonly allocatePort?: () => Promise<number>;
  readonly spawn?: (command: string, args: string[]) => ChildProcessLike;
  readonly probe?: (url: string) => Promise<void>;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

interface LocalDshDiagnostics {
  readonly codes: Set<LocalDshErrorCode>;
  readonly details: string[];
}

export interface LocalDshExit {
  readonly success: boolean;
  readonly code: number;
  readonly signal: string | null;
  readonly stopRequested: boolean;
}

export class LocalDshWeb {
  readonly exited: Promise<LocalDshExit>;
  #finished = false;
  #stopRequested = false;

  constructor(
    readonly url: string,
    private readonly child: ChildProcessLike,
    private readonly diagnosticsDone: Promise<void>,
    private readonly delay: (milliseconds: number) => Promise<void>,
  ) {
    this.exited = (async () => {
      const status = await child.status;
      this.#finished = true;
      await this.diagnosticsDone;
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

export function buildDshWebArguments(port: number): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new LocalDshError("LOCAL_PORT_BUSY", "无法分配本地端口，请重试");
  }

  return ["web", "--host", "127.0.0.1", "--port", String(port), "--no-open"];
}

export async function startLocalDshWeb(
  logger: Logger,
  options: StartLocalDshOptions = {},
): Promise<LocalDshWeb> {
  for (let attempt = 1; attempt <= MAX_LOCAL_PORT_ATTEMPTS; attempt++) {
    try {
      return await startLocalDshAttempt(logger, options);
    } catch (error) {
      if (!(error instanceof LocalDshError) || error.code !== "LOCAL_PORT_BUSY") throw error;
      logger.warn({ event: "local_dsh.port_retry", attempt }, "Local DSH Web port was busy");
    }
  }
  throw new LocalDshError("LOCAL_PORT_BUSY", "无法分配本地端口，请重试");
}

async function startLocalDshAttempt(
  logger: Logger,
  options: StartLocalDshOptions,
): Promise<LocalDshWeb> {
  const command = options.command ?? "dsh";
  const allocatePort = options.allocatePort ?? allocateLoopbackPort;
  const spawn = options.spawn ?? spawnLocalDsh;
  const probe = options.probe ?? probeHttp;
  const delay = options.delay ?? sleep;
  const now = options.now ?? Date.now;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const localPort = await allocatePort();
  const args = buildDshWebArguments(localPort);

  logger.info({
    event: "local_dsh.starting",
    port: localPort,
  }, "Starting local DSH Web");

  let child: ChildProcessLike;
  try {
    child = spawn(command, args);
  } catch (error) {
    if (isCommandNotFoundError(error)) {
      throw new LocalDshError("DSH_NOT_FOUND", dshInstallHelp());
    }
    throw error;
  }

  const diagnostics: LocalDshDiagnostics = { codes: new Set(), details: [] };
  const stderr = drainProcessStderr(child.stderr, (line) => {
    collectLocalDshDiagnostic(diagnostics, line);
  });
  const web = new LocalDshWeb(
    `http://127.0.0.1:${localPort}/`,
    child,
    stderr.done,
    delay,
  );
  const exitOutcome = web.exited.then((value) => ({
    kind: "exit" as const,
    value,
  }));

  function failureFromExit(exit: LocalDshExit): LocalDshError {
    const error = classifyLocalDshFailure(diagnostics);
    logger.warn({
      event: "local_dsh.failed",
      errorCode: error.code,
      childExitCode: exit.code,
      childSignal: exit.signal,
      childErrorDetails: diagnostics.details,
    }, "Local DSH Web failed");
    return error;
  }

  const startedAt = now();
  while (now() - startedAt < startupTimeoutMs) {
    const outcome = await Promise.race([
      exitOutcome,
      probe(web.url).then(
        () => ({ kind: "ready" as const }),
        () => ({ kind: "retry" as const }),
      ),
    ]);
    if (outcome.kind === "exit") throw failureFromExit(outcome.value);
    if (outcome.kind === "ready") {
      stderr.stopCapturing();
      logger.info({
        event: "local_dsh.ready",
        port: localPort,
        startupMs: Math.max(0, now() - startedAt),
      }, "Local DSH Web is ready");
      return web;
    }

    const pause = await Promise.race([
      exitOutcome,
      delay(150).then(() => ({ kind: "retry" as const })),
    ]);
    if (pause.kind === "exit") throw failureFromExit(pause.value);
  }

  await web.stop();
  throw new LocalDshError(
    "DSH_WEB_UNAVAILABLE",
    "dsh web 已启动，但未在限定时间内响应；请查看日志。",
  );
}

function spawnLocalDsh(command: string, args: string[]): ChildProcessLike {
  return spawnHiddenProcess(command, args);
}

function collectLocalDshDiagnostic(diagnostics: LocalDshDiagnostics, line: string): void {
  let code: LocalDshErrorCode | undefined;
  if (
    /EADDRINUSE|address already in use|cannot listen to port|listen .*127\.0\.0\.1/iu.test(line)
  ) {
    code = "LOCAL_PORT_BUSY";
  } else if (/\bENOENT\b|command not found|not found/iu.test(line)) {
    code = "DSH_NOT_FOUND";
  } else if (/\berror\b|failed|fatal|exception|panic/iu.test(line)) {
    code = "DSH_WEB_FAILED";
  }
  if (!code) return;

  diagnostics.codes.add(code);
  if (diagnostics.details.length < 5) diagnostics.details.push(line.slice(0, 2_000));
}

function classifyLocalDshFailure(diagnostics: LocalDshDiagnostics): LocalDshError {
  if (diagnostics.codes.has("LOCAL_PORT_BUSY")) {
    return new LocalDshError("LOCAL_PORT_BUSY", "本地端口刚被其他程序占用，正在重试");
  }
  if (diagnostics.codes.has("DSH_NOT_FOUND")) {
    return new LocalDshError("DSH_NOT_FOUND", dshInstallHelp());
  }
  return new LocalDshError("DSH_WEB_FAILED", "dsh web 启动失败，详细信息已写入日志。");
}

function dshInstallHelp(): string {
  return "未找到 dsh 命令，请先安装 DSH CLI，并确认 dsh 可从 PATH 启动。";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
