import { spawn } from "node:child_process";
import { PassThrough, Readable } from "node:stream";

const WINDOWS_HIDE_PROCESS = true;

export interface HiddenProcessStatus {
  readonly success: boolean;
  readonly code: number;
  readonly signal: string | null;
}

export interface ManagedHiddenProcess {
  readonly status: Promise<HiddenProcessStatus>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(signal?: Deno.Signal): void;
}

export interface HiddenCommandOutput extends HiddenProcessStatus {
  readonly stdout: string;
  readonly stderr: string;
}

export function spawnHiddenProcess(command: string, args: string[]): ManagedHiddenProcess {
  const child = spawn(command, args, {
    windowsHide: WINDOWS_HIDE_PROCESS,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const diagnostics = new PassThrough();
  child.stderr?.pipe(diagnostics, { end: false });

  let settled = false;
  let settle!: (status: HiddenProcessStatus) => void;
  const status = new Promise<HiddenProcessStatus>((resolve) => {
    settle = resolve;
  });

  const finish = (code: number, signal: string | null, error?: Error) => {
    if (settled) return;
    settled = true;
    if (error) diagnostics.write(`${error.message}\n`);
    diagnostics.end();
    settle({ success: code === 0, code, signal });
  };

  child.once("error", (error) => finish(127, null, error));
  child.once("close", (code, signal) => finish(code ?? 1, signal));

  return {
    status,
    stderr: Readable.toWeb(diagnostics) as ReadableStream<Uint8Array>,
    kill(signal = "SIGTERM") {
      child.kill(signal as NodeJS.Signals);
    },
  };
}

export async function runHiddenCommand(
  command: string,
  args: string[],
): Promise<HiddenCommandOutput> {
  const child = spawn(command, args, {
    windowsHide: WINDOWS_HIDE_PROCESS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  return await new Promise<HiddenCommandOutput>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        success: code === 0,
        code: code ?? 1,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

export async function launchDetachedHidden(
  executable: string,
  args: string[],
): Promise<void> {
  const child = spawn(executable, args, {
    detached: true,
    windowsHide: WINDOWS_HIDE_PROCESS,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    child.once("spawn", () => {
      child.off("error", onError);
      child.unref();
      resolve();
    });
    child.once("error", onError);
  });
}

export function isCommandNotFoundError(error: unknown): boolean {
  if (error instanceof Deno.errors.NotFound) return true;
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
