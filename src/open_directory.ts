import { spawn } from "node:child_process";
import { runHiddenCommand } from "./hidden_process.ts";

export function directoryOpenCommand(
  os: typeof Deno.build.os,
  directory: string,
): { command: string; args: string[] } {
  if (os === "windows") return { command: "explorer.exe", args: [directory] };
  if (os === "darwin") return { command: "open", args: [directory] };
  return { command: "xdg-open", args: [directory] };
}

export async function openDirectory(directory: string): Promise<void> {
  const { command, args } = directoryOpenCommand(Deno.build.os, directory);
  if (Deno.build.os === "windows") {
    await launchWindowsExplorer(command, args);
    return;
  }

  const result = await runHiddenCommand(command, args);
  if (result.success) return;
  const detail = (result.stderr || result.stdout).trim();
  throw new Error(detail || `${command} exited with code ${result.code}`);
}

async function launchWindowsExplorer(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, {
    detached: true,
    windowsHide: false,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}
