import { spawn } from "node:child_process";
import { basename, join, posix, resolve, win32 } from "node:path";

export const UPDATE_REPOSITORY = "Diluka/dsh-desktop-app";
export const UPDATE_RELEASE_URL = `https://github.com/${UPDATE_REPOSITORY}/releases/tag/latest`;
const RELEASE_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/tags/latest`;
const SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const ASSET_PATTERN =
  /^DSH-Desktop-(windows-x86_64-(?:cef|webview)|macos-(?:aarch64|x86_64))\.(zip|tar\.gz)$/u;

type ReleaseAsset = {
  readonly name?: unknown;
  readonly browser_download_url?: unknown;
  readonly size?: unknown;
};

type ReleasePayload = {
  readonly target_commitish?: unknown;
  readonly assets?: unknown;
};

type DetachedProcessOptions = {
  readonly detached: true;
  readonly stdio: "ignore";
  readonly windowsHide: true;
};

interface DetachedProcess {
  unref(): void;
}

export type UpdateProcessSpawner = (
  command: string,
  args: string[],
  options: DetachedProcessOptions,
) => DetachedProcess;

export interface UpdateInfo {
  readonly currentCommit: string;
  readonly latestCommit: string;
  readonly available: boolean;
  readonly releaseUrl: string;
}

export interface DownloadedUpdate extends UpdateInfo {
  readonly assetName: string;
  readonly downloadedBytes: number;
}

export interface UpdatePlatform {
  readonly os: typeof Deno.build.os;
  readonly arch: typeof Deno.build.arch;
}

export interface UpdatePaths {
  readonly updateDirectory: string;
}

export interface UpdateFetcher {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface UpdateDownloader {
  readonly paths: UpdatePaths;
  readonly backend: "cef" | "webview";
  readonly fetcher?: UpdateFetcher;
  readonly platform?: UpdatePlatform;
}

export interface UpdateApplier {
  readonly executablePath: string;
  readonly updateDirectory: string;
  readonly assetName: string;
  readonly parentPid?: number;
  readonly platform?: UpdatePlatform;
  readonly spawnProcess?: UpdateProcessSpawner;
}

interface SelectedAsset {
  readonly name: string;
  readonly downloadUrl: string;
  readonly size: number;
}

export async function checkForUpdate(
  currentCommit: string,
  fetcher: UpdateFetcher = fetch,
): Promise<UpdateInfo> {
  const normalizedCurrent = normalizeCommit(currentCommit, "当前版本");
  const release = await fetchRelease(fetcher, "检查更新");
  const latestCommit = normalizeCommit(release.target_commitish, "最新发布版本");
  return {
    currentCommit: normalizedCurrent,
    latestCommit,
    available: normalizedCurrent !== latestCommit,
    releaseUrl: UPDATE_RELEASE_URL,
  };
}

export function currentExecutablePath(executablePath = Deno.execPath()): string {
  return resolve(executablePath);
}

export function selectReleaseAsset(
  platform: UpdatePlatform,
  backend: "cef" | "webview" = "cef",
): string {
  if (platform.os === "windows" && platform.arch === "x86_64") {
    return `DSH-Desktop-windows-x86_64-${backend}.zip`;
  }
  if (platform.os === "darwin" && (platform.arch === "aarch64" || platform.arch === "x86_64")) {
    return `DSH-Desktop-macos-${platform.arch}.tar.gz`;
  }
  throw new Error(`当前平台不支持自动更新：${platform.os}/${platform.arch}`);
}

export async function downloadUpdate(
  currentCommit: string,
  downloader: UpdateDownloader,
): Promise<DownloadedUpdate> {
  const fetcher = downloader.fetcher ?? fetch;
  const update = await checkForUpdate(currentCommit, fetcher);
  if (!update.available) return { ...update, assetName: "", downloadedBytes: 0 };

  const platform = downloader.platform ?? { os: Deno.build.os, arch: Deno.build.arch };
  const assetName = selectReleaseAsset(platform, downloader.backend);
  const release = await fetchRelease(fetcher, "下载更新");
  const latestCommit = normalizeCommit(release.target_commitish, "最新发布版本");
  if (latestCommit !== update.latestCommit) {
    throw new Error("发布版本在检查后发生变化，请重新检查更新");
  }

  const asset = findAsset(release.assets, assetName);
  const archive = await fetcher(asset.downloadUrl);
  if (!archive.ok || !archive.body) {
    throw new Error(`无法下载更新包：GitHub 返回 HTTP ${archive.status}`);
  }

  await Deno.mkdir(downloader.paths.updateDirectory, { recursive: true });
  const destination = join(downloader.paths.updateDirectory, asset.name);
  const temporary = `${destination}.part`;
  await Deno.remove(temporary).catch(ignoreNotFound);
  try {
    const file = await Deno.open(temporary, { create: true, write: true, truncate: true });
    try {
      for await (const chunk of archive.body) await file.write(chunk);
    } finally {
      file.close();
    }

    const downloadedBytes = (await Deno.stat(temporary)).size;
    if (downloadedBytes !== asset.size) {
      throw new Error(`下载的更新包不完整：预期 ${asset.size} 字节，实际 ${downloadedBytes} 字节`);
    }
    await Deno.remove(destination).catch(ignoreNotFound);
    await Deno.rename(temporary, destination);
    return { ...update, assetName: asset.name, downloadedBytes };
  } catch (error) {
    await Deno.remove(temporary).catch(ignoreNotFound);
    throw error;
  }
}

export function startUpdateApplier(applier: UpdateApplier): void {
  const platform = applier.platform ?? { os: Deno.build.os, arch: Deno.build.arch };
  const parentPid = applier.parentPid ?? Deno.pid;
  if (!Number.isSafeInteger(parentPid) || parentPid < 1) {
    throw new Error("无法确定当前应用进程");
  }

  const isWindows = platform.os === "windows";
  if (!isWindows && platform.os !== "darwin") {
    throw new Error(`当前平台不支持自动更新：${platform.os}/${platform.arch}`);
  }
  const path = isWindows ? win32 : posix;
  const executablePath = path.resolve(applier.executablePath);
  const updateDirectory = path.resolve(applier.updateDirectory);
  const command = isWindows ? "cmd.exe" : "/bin/sh";
  const args = isWindows
    ? [
      "/d",
      "/s",
      "/c",
      windowsApplyCommand(executablePath, updateDirectory, applier.assetName, parentPid),
    ]
    : ["-c", macosApplyCommand(executablePath, updateDirectory, applier.assetName, parentPid)];
  const spawnProcess = applier.spawnProcess ?? spawnDetachedProcess;
  spawnProcess(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

export function windowsApplyCommand(
  executablePath: string,
  updateDirectory: string,
  assetName: string,
  parentPid = Deno.pid,
): string {
  const appDirectory = win32.dirname(executablePath);
  const archive = win32.join(updateDirectory, validateArchiveName(assetName));
  const appParent = win32.dirname(appDirectory);
  const appName = win32.basename(appDirectory);
  const stagingDirectory = win32.join(appParent, `.${appName}.update-staging`);
  const replacementDirectory = win32.join(appParent, `.${appName}.update-new`);
  const backupDirectory = win32.join(appParent, `.${appName}.update-backup`);
  if (win32.basename(executablePath).toLowerCase() !== "dsh-desktop.exe") {
    throw new Error("无法确定 Windows 应用启动程序");
  }
  return [
    `powershell.exe -NoProfile -NonInteractive -Command "Wait-Process -Id ${
      validatePid(parentPid)
    } -ErrorAction SilentlyContinue" || exit /b 1`,
    `${removeWindowsDirectory(stagingDirectory)} || exit /b 1`,
    `${removeWindowsDirectory(replacementDirectory)} || exit /b 1`,
    `${removeWindowsDirectory(backupDirectory)} || exit /b 1`,
    `mkdir ${quoteWindows(stagingDirectory)} || exit /b 1`,
    `tar -xf ${quoteWindows(archive)} -C ${quoteWindows(stagingDirectory)} || exit /b 1`,
    `move ${quoteWindows(win32.join(stagingDirectory, appName))} ${
      quoteWindows(replacementDirectory)
    } || exit /b 1`,
    `${removeWindowsDirectory(stagingDirectory)} || exit /b 1`,
    `move ${quoteWindows(appDirectory)} ${quoteWindows(backupDirectory)} || exit /b 1`,
    `move ${quoteWindows(replacementDirectory)} ${quoteWindows(appDirectory)} || (move ${
      quoteWindows(backupDirectory)
    } ${quoteWindows(appDirectory)} & exit /b 1)`,
    `${removeWindowsDirectory(updateDirectory)} || exit /b 1`,
    `start "" ${quoteWindows(win32.join(appDirectory, "DSH-Desktop.exe"))} || exit /b 1`,
    `${removeWindowsDirectory(backupDirectory)} || exit /b 1`,
  ].join(" & ");
}

export function macosApplyCommand(
  executablePath: string,
  updateDirectory: string,
  assetName: string,
  parentPid = Deno.pid,
): string {
  const appDirectory = posix.resolve(executablePath, "..", "..", "..");
  const archive = posix.join(updateDirectory, validateArchiveName(assetName));
  const appParent = posix.dirname(appDirectory);
  const appName = posix.basename(appDirectory);
  const stagingDirectory = posix.join(appParent, `.${appName}.update-staging`);
  const replacementDirectory = posix.join(appParent, `.${appName}.update-new`);
  const backupDirectory = posix.join(appParent, `.${appName}.update-backup`);
  if (!appName.endsWith(".app")) throw new Error("无法确定 macOS 应用目录");
  return [
    "set -e",
    `while kill -0 ${validatePid(parentPid)} 2>/dev/null; do sleep 1; done`,
    `rm -rf ${quoteShell(stagingDirectory)} ${quoteShell(replacementDirectory)} ${
      quoteShell(backupDirectory)
    }`,
    `mkdir -p ${quoteShell(stagingDirectory)}`,
    `tar -xzf ${quoteShell(archive)} -C ${quoteShell(stagingDirectory)}`,
    `mv ${quoteShell(posix.join(stagingDirectory, appName))} ${quoteShell(replacementDirectory)}`,
    `rm -rf ${quoteShell(stagingDirectory)}`,
    `mv ${quoteShell(appDirectory)} ${quoteShell(backupDirectory)}`,
    `if ! mv ${quoteShell(replacementDirectory)} ${quoteShell(appDirectory)}; then mv ${
      quoteShell(backupDirectory)
    } ${quoteShell(appDirectory)}; exit 1; fi`,
    `rm -rf ${quoteShell(updateDirectory)}`,
    `open ${quoteShell(appDirectory)}`,
    `rm -rf ${quoteShell(backupDirectory)}`,
  ].join("; ");
}

async function fetchRelease(fetcher: UpdateFetcher, operation: string): Promise<ReleasePayload> {
  const response = await fetcher(RELEASE_API_URL, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`无法${operation}：GitHub 返回 HTTP ${response.status}`);
  return await response.json() as ReleasePayload;
}

function normalizeCommit(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new Error(`${label}缺少有效的 commit id`);
  }
  return value.toLowerCase();
}

function findAsset(assets: unknown, expectedName: string): SelectedAsset {
  if (!Array.isArray(assets)) throw new Error("最新发布版本未包含可下载文件");
  const asset = assets.find((item): item is ReleaseAsset => {
    if (!item || typeof item !== "object") return false;
    return (item as ReleaseAsset).name === expectedName;
  });
  if (!asset || typeof asset.name !== "string" || !ASSET_PATTERN.test(asset.name)) {
    throw new Error(`最新发布版本未包含适用于当前系统的 ${expectedName}`);
  }
  if (typeof asset.browser_download_url !== "string") {
    throw new Error(`最新发布版本中的 ${asset.name} 缺少下载地址`);
  }
  if (typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size < 1) {
    throw new Error(`最新发布版本中的 ${asset.name} 缺少有效文件大小`);
  }
  return { name: asset.name, downloadUrl: asset.browser_download_url, size: asset.size };
}

function validateArchiveName(assetName: string): string {
  if (!ASSET_PATTERN.test(assetName) || basename(assetName) !== assetName) {
    throw new Error("更新包文件名无效");
  }
  return assetName;
}

function validatePid(pid: number): number {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("无法确定当前应用进程");
  return pid;
}

function quoteWindows(value: string): string {
  if (value.includes('"') || value.includes("%")) {
    throw new Error("更新路径不能包含双引号或百分号");
  }
  return `"${value}"`;
}

function removeWindowsDirectory(directory: string): string {
  const quotedDirectory = quoteWindows(directory);
  return `if exist ${quotedDirectory} (rmdir /s /q ${quotedDirectory}) else (ver > nul)`;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function ignoreNotFound(error: unknown): void {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}

function spawnDetachedProcess(
  command: string,
  args: string[],
  options: DetachedProcessOptions,
): DetachedProcess {
  return spawn(command, args, options);
}
