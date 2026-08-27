import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { windowsPowershellCommand } from "./windows_powershell.ts";
import { assignChildToKillOnCloseJob } from "./windows_job.ts";

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

function resolveProcessLaunch(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  if (Deno.build.os !== "windows") return { command, args };
  if (command.toLowerCase().endsWith(".ps1")) {
    // npm installs .ps1 shims on Windows; PowerShell is built in, so no cmd.exe
    // dependency is needed, and pwsh (PowerShell 7) is preferred when the user
    // installed it. Running the .ps1 through PowerShell keeps `node` a direct
    // child of the PowerShell process, so taskkill /t and the job object can
    // terminate the whole tree instead of orphaning the node processes that
    // `dsh web` spawns.
    return {
      command: windowsPowershellCommand(),
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        command,
        ...args,
      ],
    };
  }
  return { command, args };
}

function killManagedProcess(child: ChildProcess, signal: Deno.Signal): void {
  // On Windows the spawned child is the PowerShell process, and killing only
  // that process with child.kill leaves its descendants (the node processes
  // running `dsh web`) running, since Windows does not cascade process
  // termination to children. Terminate the whole tree with taskkill /t so
  // nothing is left behind after the window closes.
  if (Deno.build.os === "windows" && child.pid && child.exitCode === null) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: WINDOWS_HIDE_PROCESS,
      stdio: "ignore",
    });
    killer.once("error", () => child.kill(signal as NodeJS.Signals));
    killer.unref();
    return;
  }
  child.kill(signal as NodeJS.Signals);
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
  // Keep the spawned tree alive only while this app runs: the OS terminates all
  // job members when this process exits, even if the window closes before the
  // async shutdown cleanup finishes.
  if (Deno.build.os === "windows") assignChildToKillOnCloseJob(child.pid);

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
      killManagedProcess(child, signal);
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
