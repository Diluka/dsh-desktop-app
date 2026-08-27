import type { Logger } from "pino";
import {
  isCommandNotFoundError,
  type ManagedHiddenProcess,
  readProcessOutputTail,
} from "./hidden_process.ts";
import { allocateLoopbackPort, probeHttp } from "./loopback_http.ts";

const MAX_LOCAL_PORT_ATTEMPTS = 3;
const NPX_DSH_PACKAGE = "@deepseek-ai/dsh";

export type LocalDshErrorCode =
  | "DSH_NOT_FOUND"
  | "LOCAL_PORT_BUSY"
  | "DSH_WEB_FAILED"
  | "START_CANCELLED";

export class LocalDshError extends Error {
  override name = "LocalDshError";

  constructor(readonly code: LocalDshErrorCode, message: string) {
    super(message);
  }
}

interface StartLocalDshOptions {
  readonly command?: string;
  readonly allocatePort?: () => Promise<number>;
  readonly spawn: (command: string, args: string[]) => ManagedHiddenProcess;
  readonly probe?: (url: string) => Promise<void>;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly signal?: AbortSignal;
}

export interface LocalDshExit {
  readonly success: boolean;
  readonly code: number;
  readonly signal: string | null;
  readonly error?: Error;
  readonly stopRequested: boolean;
}

export class LocalDshWeb {
  readonly exited: Promise<LocalDshExit>;
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

export function buildDshWebArguments(port: number): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new LocalDshError("LOCAL_PORT_BUSY", "无法分配本地端口，请重试");
  }

  return ["web", "--host", "127.0.0.1", "--port", String(port), "--no-open"];
}

export async function startLocalDshWeb(
  logger: Logger,
  options: StartLocalDshOptions,
): Promise<LocalDshWeb> {
  const cancelOutcome = waitForCancellation(options.signal);
  let launcher: "dsh" | "npx" = "dsh";
  let portAttempt = 0;
  while (portAttempt < MAX_LOCAL_PORT_ATTEMPTS) {
    throwIfCancelled(options.signal);
    try {
      return await startLocalDshAttempt(logger, options, launcher, cancelOutcome);
    } catch (error) {
      throwIfCancelled(options.signal);
      if (error instanceof LocalDshError && error.code === "START_CANCELLED") throw error;
      if (launcher === "dsh" && error instanceof LocalDshError && error.code === "DSH_NOT_FOUND") {
        launcher = "npx";
        logger.warn(
          { event: "local_dsh.npx_fallback", package: NPX_DSH_PACKAGE },
          "Local dsh command was unavailable; falling back to npx",
        );
        continue;
      }
      if (error instanceof LocalDshError && error.code === "LOCAL_PORT_BUSY") {
        portAttempt += 1;
        logger.warn(
          { event: "local_dsh.port_retry", launcher, attempt: portAttempt },
          "Local DSH Web port was busy",
        );
        continue;
      }
      if (launcher === "npx") {
        logger.warn({ event: "local_dsh.npx_failed", err: error }, "npx fallback failed");
        throw new LocalDshError("DSH_NOT_FOUND", dshInstallHelp());
      }
      throw error;
    }
  }
  throw new LocalDshError("LOCAL_PORT_BUSY", "无法分配本地端口，请重试");
}

async function startLocalDshAttempt(
  logger: Logger,
  options: StartLocalDshOptions,
  launcher: "dsh" | "npx",
  cancelOutcome: Promise<{ kind: "cancel" }>,
): Promise<LocalDshWeb> {
  throwIfCancelled(options.signal);
  const allocatePort = options.allocatePort ?? allocateLoopbackPort;
  const spawn = options.spawn;
  const probe = options.probe ?? probeHttp;
  const delay = options.delay ?? sleep;
  const allocation = await Promise.race([
    allocatePort().then((port) => ({ kind: "port" as const, port })),
    cancelOutcome,
  ]);
  if (allocation.kind === "cancel") throw cancelledError();
  throwIfCancelled(options.signal);
  const localPort = allocation.port;
  const prefix: [string, ...string[]] = launcher === "npx"
    ? [Deno.build.os === "windows" ? "npx.cmd" : "npx", "-y", NPX_DSH_PACKAGE]
    : [options.command ?? "dsh"];
  const [command, ...args] = [
    ...prefix,
    ...buildDshWebArguments(localPort),
  ] as [string, ...string[]];

  logger.info({
    event: "local_dsh.starting",
    launcher,
    port: localPort,
  }, "Starting local DSH Web");

  let child: ManagedHiddenProcess;
  try {
    child = spawn(command, args);
  } catch (error) {
    if (isCommandNotFoundError(error)) {
      throw new LocalDshError("DSH_NOT_FOUND", dshInstallHelp());
    }
    throw error;
  }

  const web = new LocalDshWeb(`http://127.0.0.1:${localPort}/`, child, delay);
  const exitOutcome = web.exited.then((value) => ({
    kind: "exit" as const,
    value,
  }));

  async function failureFromExit(exit: LocalDshExit): Promise<LocalDshError> {
    const detail = await readProcessOutputTail(web.outputFile);
    const error = classifyLocalDshFailure(detail, exit.error);
    logger.warn({
      event: "local_dsh.failed",
      errorCode: error.code,
      childExitCode: exit.code,
      childSignal: exit.signal,
      childOutputFile: web.outputFile,
      ...(exit.error ? { err: exit.error } : {}),
    }, "Local DSH Web failed");
    return error;
  }

  const startedAt = Date.now();
  while (true) {
    const outcome = await Promise.race([
      exitOutcome,
      cancelOutcome,
      probe(web.url).then(
        () => ({ kind: "ready" as const }),
        () => ({ kind: "retry" as const }),
      ),
    ]);
    if (outcome.kind === "cancel") {
      await web.stop();
      throw cancelledError();
    }
    if (outcome.kind === "exit") throw await failureFromExit(outcome.value);
    if (outcome.kind === "ready") {
      if (options.signal?.aborted) {
        await web.stop();
        throw cancelledError();
      }
      logger.info({
        event: "local_dsh.ready",
        port: localPort,
        childOutputFile: web.outputFile,
        startupMs: Math.max(0, Date.now() - startedAt),
      }, "Local DSH Web is ready");
      return web;
    }

    const pause = await Promise.race([
      exitOutcome,
      cancelOutcome,
      delay(150).then(() => ({ kind: "retry" as const })),
    ]);
    if (pause.kind === "cancel") {
      await web.stop();
      throw cancelledError();
    }
    if (pause.kind === "exit") throw await failureFromExit(pause.value);
  }
}

function classifyLocalDshFailure(detail: string, processError?: Error): LocalDshError {
  if (
    /EADDRINUSE|address already in use|cannot listen to port|listen .*127\.0\.0\.1/iu.test(
      detail,
    )
  ) {
    return new LocalDshError("LOCAL_PORT_BUSY", "本地端口刚被其他程序占用，正在重试");
  }
  if (isCommandNotFoundError(processError)) {
    return new LocalDshError("DSH_NOT_FOUND", dshInstallHelp());
  }
  return new LocalDshError("DSH_WEB_FAILED", "dsh web 启动失败，详细信息已写入日志。");
}

function waitForCancellation(signal?: AbortSignal): Promise<{ kind: "cancel" }> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) {
      resolve({ kind: "cancel" });
      return;
    }
    signal.addEventListener("abort", () => resolve({ kind: "cancel" }), { once: true });
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError();
}

function cancelledError(): LocalDshError {
  return new LocalDshError("START_CANCELLED", "本地模式启动已终止");
}

function dshInstallHelp(): string {
  return "无法通过 dsh 或 npx 启动 DSH，请安装 DSH CLI 并确认 dsh 可从 PATH 启动。";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
