import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

const WINDOWS_HIDE_PROCESS = true;
const MAX_OUTPUT_TAIL_BYTES = 16 * 1024;
// cmd.exe returns errorlevel 9009 (0x2331) when it cannot find the command it
// was asked to run, instead of failing the spawn with an ENOENT error.
const WINDOWS_CMD_NOT_FOUND_CODE = 0x2331;

export function isWindowsCommandNotFoundExit(
  os: typeof Deno.build.os,
  command: string,
  code: number | null,
): boolean {
  return os === "windows" &&
    command.toLowerCase().endsWith(".cmd") &&
    code === WINDOWS_CMD_NOT_FOUND_CODE;
}

export interface HiddenProcessStatus {
  readonly success: boolean;
  readonly code: number;
  readonly signal: string | null;
  readonly error?: Error;
}

export interface ManagedHiddenProcess {
  readonly outputFile: string;
  readonly status: Promise<HiddenProcessStatus>;
  kill(signal?: Deno.Signal): void;
}

export interface HiddenCommandOutput extends HiddenProcessStatus {
  readonly stdout: string;
  readonly stderr: string;
}

function resolveProcessLaunch(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  return Deno.build.os === "windows" && command.toLowerCase().endsWith(".cmd")
    ? {
      command: Deno.env.get("ComSpec") ?? "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    }
    : { command, args };
}

export function spawnHiddenProcess(
  command: string,
  args: string[],
  logDirectory: string,
): ManagedHiddenProcess {
  const launch = resolveProcessLaunch(command, args);
  const outputFile = join(logDirectory, `dsh-desktop-child-${crypto.randomUUID()}.log`);
  const outputFd = openSync(outputFile, "a", 0o600);
  const child = (() => {
    try {
      return spawn(launch.command, launch.args, {
        windowsHide: WINDOWS_HIDE_PROCESS,
        stdio: ["ignore", outputFd, outputFd],
      });
    } finally {
      closeSync(outputFd);
    }
  })();

  let settled = false;
  let settle!: (status: HiddenProcessStatus) => void;
  const status = new Promise<HiddenProcessStatus>((resolve) => {
    settle = resolve;
  });

  const finish = (code: number, signal: string | null, error?: Error) => {
    if (settled) return;
    settled = true;
    settle({ success: code === 0, code, signal, ...(error ? { error } : {}) });
  };

  child.once("error", (error) => finish(127, null, error));
  child.once("close", (code, signal) => {
    if (isWindowsCommandNotFoundExit(Deno.build.os, command, code)) {
      finish(code ?? 1, signal, new Deno.errors.NotFound(`${command} was not found`));
      return;
    }
    finish(code ?? 1, signal);
  });

  return {
    outputFile,
    status,
    kill(signal = "SIGTERM") {
      child.kill(signal as NodeJS.Signals);
    },
  };
}

export async function readProcessOutputTail(filePath: string): Promise<string> {
  try {
    const file = await Deno.open(filePath, { read: true });
    try {
      const { size } = await file.stat();
      const length = Math.min(size, MAX_OUTPUT_TAIL_BYTES);
      await file.seek(size - length, Deno.SeekMode.Start);
      const bytes = new Uint8Array(length);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await file.read(bytes.subarray(offset));
        if (read === null) break;
        offset += read;
      }
      let start = 0;
      while (start < offset && (bytes[start] & 0xc0) === 0x80) start += 1;
      return new TextDecoder().decode(bytes.subarray(start, offset)).trim();
    } finally {
      file.close();
    }
  } catch {
    return "";
  }
}

export async function runHiddenCommand(
  command: string,
  args: string[],
  timeoutMilliseconds?: number,
): Promise<HiddenCommandOutput> {
  const launch = resolveProcessLaunch(command, args);
  const child = spawn(launch.command, launch.args, {
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
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (output: HiddenCommandOutput) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(output);
    };

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (isWindowsCommandNotFoundExit(Deno.build.os, command, code)) {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        reject(new Deno.errors.NotFound(`${command} was not found`));
        return;
      }
      finish({
        success: code === 0,
        code: code ?? 1,
        signal,
        stdout,
        stderr,
      });
    });
    if (!settled && timeoutMilliseconds && timeoutMilliseconds > 0) {
      timeout = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The command may have exited between the timer firing and kill.
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ success: false, code: 1, signal: "SIGKILL", stdout, stderr });
      }, timeoutMilliseconds);
    }
  });
}

export function isCommandNotFoundError(error: unknown): boolean {
  if (error instanceof Deno.errors.NotFound) return true;
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
