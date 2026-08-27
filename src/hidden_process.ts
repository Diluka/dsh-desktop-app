import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

const WINDOWS_HIDE_PROCESS = true;
const MAX_OUTPUT_TAIL_BYTES = 16 * 1024;

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

export function spawnHiddenProcess(
  command: string,
  args: string[],
  logDirectory: string,
): ManagedHiddenProcess {
  const launch = Deno.build.os === "windows" && command.toLowerCase().endsWith(".cmd")
    ? {
      command: Deno.env.get("ComSpec") ?? "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    }
    : { command, args };
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
  child.once("close", (code, signal) => finish(code ?? 1, signal));

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

export function isCommandNotFoundError(error: unknown): boolean {
  if (error instanceof Deno.errors.NotFound) return true;
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
