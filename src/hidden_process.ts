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

export function isCommandNotFoundError(error: unknown): boolean {
  if (error instanceof Deno.errors.NotFound) return true;
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function monitorProcessStderr(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): { done: Promise<readonly string[]> } {
  const tail: string[] = [];
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
        for (const line of lines) storeLine(line);
      }
      pending += decoder.decode();
      if (pending) storeLine(pending);
    } finally {
      reader.releaseLock();
    }
    return tail;
  })();

  return { done };

  function storeLine(raw: string): void {
    const line = Array.from(raw)
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code === 9 || (code >= 32 && code !== 127);
      })
      .join("")
      .trim();
    if (!line) return;

    const clipped = line.slice(0, 2_000);
    tail.push(clipped);
    if (tail.length > 20) tail.shift();
    onLine(clipped);
  }
}
