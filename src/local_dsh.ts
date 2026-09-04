import type { Logger } from "pino";
import { latestDshWebLaunchTokenUrl } from "./dsh_web.ts";
import {
  isCommandNotFoundError,
  type ManagedHiddenProcess,
  readProcessOutputTail,
  runHiddenCommand,
} from "./hidden_process.ts";
import { allocateLoopbackPort, probeHttp } from "./loopback_http.ts";
import { ManagedEndpoint, type ManagedEndpointExit } from "./managed_endpoint.ts";
import {
  detectWindowsPowershell,
  windowsPowershellCommand,
  type WindowsPowershellStatus,
} from "./windows_powershell.ts";

const MAX_LOCAL_PORT_ATTEMPTS = 3;
const COMMAND_PATH_TIMEOUT_MS = 10_000;
const NPX_DSH_PACKAGE = "@deepseek-ai/dsh";
const LOGIN_SHELL_EXEC = 'exec "$0" "$@"';
const TOOL_PROBE_MARKER = "__DSH_DESKTOP_TOOL__";

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
  readonly powershell?: WindowsPowershellStatus;
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

export type LocalDshExit = ManagedEndpointExit;

export class LocalDshWeb extends ManagedEndpoint {
  useAuthenticatedUrl(url: string): void {
    this.replaceUrl(url);
  }
}

export function buildDshWebArguments(port: number): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new LocalDshError("LOCAL_PORT_BUSY", "无法分配本地端口，请重试");
  }

  return ["web", "--host", "127.0.0.1", "--port", String(port), "--no-open"];
}

function authenticatedLocalDshUrl(output: string): string | undefined {
  return latestDshWebLaunchTokenUrl(output);
}

export async function probeLocalDshEnvironment(
  probe: (command: string, args: string[]) => Promise<CommandProbeOutput> = (command, args) =>
    runHiddenCommand(command, args, COMMAND_PATH_TIMEOUT_MS),
  os: typeof Deno.build.os = Deno.build.os,
  loginShell = Deno.env.get("SHELL") ?? (os === "darwin" ? "/bin/zsh" : "/bin/sh"),
): Promise<LocalDshEnvironment> {
  return os === "windows"
    ? await probeWindowsEnvironment(probe)
    : await probeLoginShellEnvironment(probe, loginShell);
}

async function probeLoginShellEnvironment(
  probe: (command: string, args: string[]) => Promise<CommandProbeOutput>,
  shell: string,
): Promise<LocalDshEnvironment> {
  let output: CommandProbeOutput;
  try {
    output = await probe(shell, ["-lic", buildToolProbeScript()]);
  } catch {
    return {};
  }

  const values: Record<string, string> = {};
  for (const line of output.stdout.split(/\r?\n/u).map((value) => value.trim())) {
    if (!line.startsWith(TOOL_PROBE_MARKER)) continue;
    const separator = line.indexOf("=", TOOL_PROBE_MARKER.length);
    if (separator < 0) continue;
    values[line.slice(TOOL_PROBE_MARKER.length, separator)] = line.slice(separator + 1);
  }

  const node = toolInfo(values, "node");
  const dsh = toolInfo(values, "dsh");
  const npx = toolInfo(values, "npx");
  const dshPresent = Boolean(values["dsh.command"]);
  const launcher: LocalDshLauncher | undefined = dsh
    ? { kind: "dsh", command: shell, prefix: ["-lic", LOGIN_SHELL_EXEC, "dsh"] }
    : !dshPresent && npx
    ? {
      kind: "npx",
      command: shell,
      prefix: ["-lic", LOGIN_SHELL_EXEC, "npx", "-y", NPX_DSH_PACKAGE],
    }
    : undefined;
  return { node, dsh, npx, launcher };
}

function buildToolProbeScript(): string {
  return ["node", "dsh", "npx"].map((tool) =>
    `if command -v ${tool} >/dev/null 2>&1; then ` +
    `printf '${TOOL_PROBE_MARKER}${tool}.command=%s\\n' "$(command -v ${tool})"; ` +
    `if version="$(${tool} --version 2>/dev/null)"; then ` +
    `printf '${TOOL_PROBE_MARKER}${tool}.version=%s\\n' "$version"; fi; fi`
  ).join("; ");
}

function toolInfo(values: Record<string, string>, tool: string): LocalToolInfo | undefined {
  const command = values[`${tool}.command`];
  const version = values[`${tool}.version`];
  return command && version ? { command, version } : undefined;
}

async function probeWindowsEnvironment(
  probe: (command: string, args: string[]) => Promise<CommandProbeOutput>,
): Promise<LocalDshEnvironment> {
  // Prefer PowerShell 7 (pwsh) when installed; probe it first and cache the
  // executable used for .ps1 shims.
  const powershell = await detectWindowsPowershell(probe);
  const [nodeProbe, dshProbe, npxProbe] = await Promise.all([
    probeWindowsTool(["node"], probe),
    probeWindowsTool(["dsh.ps1"], probe),
    probeWindowsTool(["npx.ps1"], probe),
  ]);
  const node = nodeProbe.info;
  const dsh = dshProbe.info;
  const npx = npxProbe.info;
  const launcher: LocalDshLauncher | undefined = dsh
    ? { kind: "dsh", command: dsh.command, prefix: [] }
    : dshProbe.missing && npx
    ? { kind: "npx", command: npx.command, prefix: ["-y", NPX_DSH_PACKAGE] }
    : undefined;
  return { node, dsh, npx, powershell, launcher };
}

async function probeWindowsTool(
  candidates: readonly string[],
  probe: (command: string, args: string[]) => Promise<CommandProbeOutput>,
): Promise<LocalToolProbeResult> {
  for (const command of candidates) {
    if (command.toLowerCase().endsWith(".ps1")) {
      // powershell -File does not search PATH for a bare script name, so resolve
      // the shim's absolute path first. Launching the .ps1 through PowerShell
      // keeps `node` a direct child so the job object and taskkill /t can
      // terminate the whole tree.
      const path = await resolveWindowsPs1Path(command, probe);
      if (!path) continue;
      const result = await probeLocalTool(path, probe);
      if (result.info) return result;
      continue;
    }
    // node.exe is resolved through PATH by CreateProcess directly.
    const result = await probeLocalTool(command, probe);
    if (result.info) return result;
  }
  return { missing: true };
}

async function resolveWindowsPs1Path(
  name: string,
  probe: (command: string, args: string[]) => Promise<CommandProbeOutput>,
): Promise<string | undefined> {
  try {
    const output = await probe(windowsPowershellCommand(), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Command ${name} -ErrorAction SilentlyContinue).Source`,
    ]);
    return output.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => /^[a-z]:[\\/]/iu.test(line));
  } catch {
    return undefined;
  }
}

async function probeLocalTool(
  command: string,
  probe: (command: string, args: string[]) => Promise<CommandProbeOutput>,
): Promise<LocalToolProbeResult> {
  let output: CommandProbeOutput;
  try {
    output = await probe(command, ["--version"]);
  } catch (error) {
    return { missing: isCommandNotFoundError(error) };
  }
  if (!output.success) return { missing: false };
  const version = [output.stdout, output.stderr]
    .map((text) => text.split(/\r?\n/u).map((line) => line.trim()).findLast(Boolean))
    .find(Boolean);
  return version ? { info: { command, version }, missing: false } : { missing: false };
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

  const baseUrl = `http://127.0.0.1:${localPort}/`;
  const web = new LocalDshWeb(baseUrl, child, delay);
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
    if (web.url === baseUrl) {
      const authenticatedUrl = authenticatedLocalDshUrl(
        await readProcessOutputTail(web.outputFile),
      );
      if (authenticatedUrl) web.useAuthenticatedUrl(authenticatedUrl);
    }

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
