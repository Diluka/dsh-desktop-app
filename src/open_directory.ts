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

export function externalUrlOpenCommand(
  os: typeof Deno.build.os,
  url: string,
): { command: string; args: string[] } {
  validateExternalUrl(url);
  if (os === "windows") return { command: "explorer.exe", args: [url] };
  if (os === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

export async function openDirectory(directory: string): Promise<void> {
  const { command, args } = directoryOpenCommand(Deno.build.os, directory);
  await openWithPlatformCommand(command, args);
}

export async function openExternalUrl(url: string): Promise<void> {
  const { command, args } = externalUrlOpenCommand(Deno.build.os, url);
  await openWithPlatformCommand(command, args);
}

async function openWithPlatformCommand(command: string, args: string[]): Promise<void> {
  if (Deno.build.os === "windows") {
    await launchWindowsExplorer(command, args);
    return;
  }

  const result = await runHiddenCommand(command, args);
  if (result.success) return;
  const detail = (result.stderr || result.stdout).trim();
  throw new Error(detail || `${command} exited with code ${result.code}`);
}

function validateExternalUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("外部链接格式无效");
  }
  if (parsed.protocol !== "https:") throw new Error("只允许打开 HTTPS 外部链接");
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
