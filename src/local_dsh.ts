import type { Logger } from "pino";
import {
  isCommandNotFoundError,
  type ManagedHiddenProcess,
  readProcessOutputTail,
  runHiddenCommand,
} from "./hidden_process.ts";
import { allocateLoopbackPort, probeHttp } from "./loopback_http.ts";

const MAX_LOCAL_PORT_ATTEMPTS = 3;
const COMMAND_PROBE_TIMEOUT_MS = 5_000;
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

export interface LocalDshLauncher {
  readonly kind: "dsh" | "npx";
  readonly command: string;
  readonly prefix: readonly string[];
}

export interface LocalToolInfo {
  readonly command: string;
  readonly version: string;
}

export interface LocalDshEnvironment {
  readonly node?: LocalToolInfo;
  readonly dsh?: LocalToolInfo;
  readonly npx?: LocalToolInfo;
  readonly launcher?: LocalDshLauncher;
}

interface CommandProbeOutput {
  readonly success: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

interface LocalToolProbeResult {
  readonly info?: LocalToolInfo;
  readonly missing: boolean;
}

interface StartLocalDshOptions {
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

export async function probeLocalDshEnvironment(
  probe: (command: string, args: string[]) => Promise<CommandProbeOutput> = (command, args) =>
    runHiddenCommand(command, args, COMMAND_PROBE_TIMEOUT_MS),
  os: typeof Deno.build.os = Deno.build.os,
  resolveFromShell: (command: string) => Promise<string | undefined> = (command) =>
    resolveCommandPath(command, os),
): Promise<LocalDshEnvironment> {
  const commandExtension = os === "windows" ? ".cmd" : "";
  const [nodeProbe, dshProbe, npxProbe] = await Promise.all([
    probeLocalTool("node", probe, resolveFromShell, true),
    probeLocalTool(`dsh${commandExtension}`, probe, resolveFromShell),
    probeLocalTool(`npx${commandExtension}`, probe, resolveFromShell),
  ]);
  const node = nodeProbe.info;
  const dsh = dshProbe.info;
  const npx = npxProbe.info;
  const launcher: LocalDshLauncher | undefined = dsh
    ? { kind: "dsh", command: dsh.command, prefix: [] }
    : dshProbe.missing && node && npx
    ? { kind: "npx", command: npx.command, prefix: ["-y", NPX_DSH_PACKAGE] }
    : undefined;
  return { node, dsh, npx, launcher };
}

async function probeLocalTool(
  initialCommand: string,
  probe: (command: string, args: string[]) => Promise<CommandProbeOutput>,
  resolveFromShell: (command: string) => Promise<string | undefined>,
  resolveBeforeProbe = false,
): Promise<LocalToolProbeResult> {
  let command = initialCommand;
  if (resolveBeforeProbe) {
    const resolved = await resolveFromShell(command).catch(() => undefined);
    if (!resolved) return { missing: true };
    command = resolved;
  }
  let output: CommandProbeOutput;
  try {
    output = await probe(command, ["--version"]);
  } catch (error) {
    if (!isCommandNotFoundError(error)) return { missing: false };
    if (resolveBeforeProbe) return { missing: true };
    const resolved = await resolveFromShell(command).catch(() => undefined);
    if (!resolved) return { missing: true };
    command = resolved;
    try {
      output = await probe(command, ["--version"]);
    } catch (resolvedError) {
      return { missing: isCommandNotFoundError(resolvedError) };
    }
  }
  if (!output.success) return { missing: false };
  const version = [output.stdout, output.stderr]
    .map((text) => text.split(/\r?\n/u).map((line) => line.trim()).findLast(Boolean))
    .find(Boolean);
  return version ? { info: { command, version }, missing: false } : { missing: false };
}

async function resolveCommandPath(
  command: string,
  os: typeof Deno.build.os,
): Promise<string | undefined> {
  if (!/^[a-z0-9._-]+$/iu.test(command)) return undefined;
  if (os === "windows") {
    try {
      const result = await runHiddenCommand("where.exe", [command], COMMAND_PROBE_TIMEOUT_MS);
      if (!result.success) return undefined;
      return result.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find((line) => /^[a-z]:[\\/]/iu.test(line));
    } catch {
      return undefined;
    }
  }
  const shell = Deno.env.get("SHELL") ?? (os === "darwin" ? "/bin/zsh" : "/bin/sh");

  try {
    const marker = "__DSH_DESKTOP_COMMAND__=";
    const script = `command -v ${command} | sed 's#^#${marker}#'`;
    const result = await runHiddenCommand(shell, [
      "-lic",
      script,
    ], COMMAND_PROBE_TIMEOUT_MS);
    if (!result.success) return undefined;
    const resolved = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .findLast((line) => line.startsWith(marker))
      ?.slice(marker.length);
    return resolved?.startsWith("/") ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export async function startLocalDshWeb(
  logger: Logger,
  launcher: LocalDshLauncher,
  options: StartLocalDshOptions,
): Promise<LocalDshWeb> {
  const cancelOutcome = waitForCancellation(options.signal);
  for (let attempt = 1; attempt <= MAX_LOCAL_PORT_ATTEMPTS; attempt++) {
    throwIfCancelled(options.signal);
    try {
      return await startLocalDshAttempt(logger, launcher, options, cancelOutcome);
    } catch (error) {
      throwIfCancelled(options.signal);
      if (error instanceof LocalDshError && error.code === "START_CANCELLED") throw error;
      if (!(error instanceof LocalDshError) || error.code !== "LOCAL_PORT_BUSY") throw error;
      logger.warn(
        { event: "local_dsh.port_retry", launcher: launcher.kind, attempt },
        "Local DSH Web port was busy",
      );
    }
  }
  throw new LocalDshError("LOCAL_PORT_BUSY", "无法分配本地端口，请重试");
}

async function startLocalDshAttempt(
  logger: Logger,
  launcher: LocalDshLauncher,
  options: StartLocalDshOptions,
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
  const [command, ...args] = [
    launcher.command,
    ...launcher.prefix,
    ...buildDshWebArguments(localPort),
  ];

  logger.info({
    event: "local_dsh.starting",
    launcher: launcher.kind,
    port: localPort,
  }, "Starting local DSH Web");

  let child: ManagedHiddenProcess;
  try {
    child = spawn(command, args);
  } catch (error) {
    if (isCommandNotFoundError(error)) throw localDshInstallError();
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
  if (isCommandNotFoundError(processError)) return localDshInstallError();
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

export function localDshInstallError(): LocalDshError {
  return new LocalDshError(
    "DSH_NOT_FOUND",
    "无法通过 dsh 或 npx 启动 DSH，请安装 DSH CLI，或确认终端中的 npx 可用。",
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
