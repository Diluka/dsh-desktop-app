import { resolveAppPaths } from "./src/app_paths.ts";
import { detectSystemLocale } from "./src/browser_locale.ts";
import { createLogger } from "./src/logger.ts";
import { openDirectory } from "./src/open_directory.ts";
import { ProfileStore } from "./src/profiles.ts";
import { probeOpenSsh, SshTunnel, startSshTunnel, TunnelError } from "./src/ssh_tunnel.ts";
import { handleShellRequest } from "./src/ui.ts";
import { setWindowsWindowIcon } from "./src/windows_window_icon.ts";

const systemLocale = detectSystemLocale();
Deno.serve({ hostname: "127.0.0.1" }, handleShellRequest);
const paths = resolveAppPaths();
const logger = await createLogger(paths.logDirectory);
logger.info({
  event: "app.start",
  version: Deno.version.deno,
  os: Deno.build.os,
  arch: Deno.build.arch,
  ...(systemLocale ? { systemLocale } : {}),
}, "DSH Desktop is starting");
const { store, recoveredBackup } = await ProfileStore.open(paths.configFile);
let startupNotice = recoveredBackup
  ? `检测到损坏的服务器配置，原文件已保留为 ${recoveredBackup}`
  : undefined;
if (recoveredBackup) {
  logger.warn({
    event: "profiles.recovered",
    backupPath: recoveredBackup,
  }, "Recovered from an invalid profile file");
}

const ssh = await probeOpenSsh();
logger.info({
  event: "ssh.probe",
  available: ssh.available,
  version: ssh.version ?? "unknown",
}, ssh.available ? "OpenSSH Client is available" : "OpenSSH Client is unavailable");

const shellUrl = resolveShellUrl();
const nativeWindowTitle = Deno.build.os === "windows" ? `DSH Desktop ${Deno.pid}` : "DSH Desktop";
const window = new Deno.BrowserWindow({ title: nativeWindowTitle });
let releaseWindowIcon: (() => void) | undefined;
if (Deno.build.os === "windows") {
  try {
    releaseWindowIcon = setWindowsWindowIcon(nativeWindowTitle);
    logger.info({ event: "window.icon_applied" }, "Applied the native Windows window icon");
  } catch (error) {
    logger.warn(
      { event: "window.icon_failed", err: error },
      "Could not apply the Windows window icon",
    );
  } finally {
    window.setTitle("DSH Desktop");
  }
}

let activeTunnel: SshTunnel | undefined;
let connecting = false;
let shellBindingsActive = false;
let shuttingDown = false;
let closeAllowed = false;

bindShell();
window.addEventListener("close", (event) => {
  if (closeAllowed) return;
  event.preventDefault();
  void shutdown();
});

addEventListener("error", (event) => {
  logger.error({ event: "app.uncaught_error", err: event.error }, "Uncaught application error");
});
addEventListener("unhandledrejection", (event) => {
  logger.error(
    { event: "app.unhandled_rejection", err: event.reason },
    "Unhandled application rejection",
  );
});

function bindShell(): void {
  if (shellBindingsActive) return;
  // Deno 2.9 BrowserWindow.bind requires handlers to return a Promise.
  // deno-lint-ignore require-await
  window.bind("bootstrap", async () => ({
    profiles: store.list(),
    ssh,
    logDirectory: paths.logDirectory,
    ...(startupNotice ? { startupNotice } : {}),
  }));
  window.bind("saveProfile", async (input: unknown) => {
    try {
      const profile = await store.save(input);
      logger.info({
        event: "profiles.saved",
        profileId: profile.id,
        sshTarget: profile.sshTarget,
        remotePort: profile.remotePort,
      }, "Server profile was saved");
      return profile;
    } catch (error) {
      logger.error({ event: "profiles.save_failed", err: error }, "Failed to save server profile");
      throw error;
    }
  });
  window.bind("deleteProfile", async (id: unknown) => {
    const deleted = await store.delete(id);
    if (deleted) {
      logger.info({
        event: "profiles.deleted",
        profileId: String(id),
      }, "Server profile was deleted");
    }
    return deleted;
  });
  window.bind("openLogDirectory", async () => {
    try {
      await openDirectory(paths.logDirectory);
      logger.info(
        { event: "logs.directory_open_requested" },
        "Requested opening the log directory",
      );
      return null;
    } catch (error) {
      logger.error(
        { event: "logs.directory_open_failed", err: error },
        "Failed to open the log directory",
      );
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`无法打开日志目录：${detail}`);
    }
  });
  window.bind("connectProfile", async (id: unknown) => {
    await connectProfile(id);
    return null;
  });
  shellBindingsActive = true;
}

function unbindShell(): void {
  if (!shellBindingsActive) return;
  window.unbind("bootstrap");
  window.unbind("saveProfile");
  window.unbind("deleteProfile");
  window.unbind("openLogDirectory");
  window.unbind("connectProfile");
  shellBindingsActive = false;
}

async function connectProfile(id: unknown): Promise<void> {
  if (connecting) throw new Error("已有 SSH 连接正在建立，请稍候");
  if (!ssh.available) throw new Error(ssh.installHelp ?? "未找到 OpenSSH Client");
  if (typeof id !== "string") throw new Error("服务器 ID 无效");

  const profile = store.get(id);
  if (!profile) throw new Error("服务器配置不存在或已被删除");
  connecting = true;
  try {
    if (activeTunnel) await activeTunnel.stop();
    const tunnel = await startSshTunnel(profile, logger);
    activeTunnel = tunnel;

    // The remote page must not inherit privileged bindings from the local selector.
    unbindShell();
    try {
      window.navigate(tunnel.url);
    } catch (error) {
      bindShell();
      activeTunnel = undefined;
      await tunnel.stop();
      throw error;
    }
    void observeTunnel(tunnel, profile.name);
  } catch (error) {
    logger.error({
      event: "ssh.connect_failed",
      profileId: profile.id,
      err: error,
    }, "Failed to connect a server profile");
    if (error instanceof TunnelError) throw error;
    throw new Error("连接失败，详细信息已写入日志");
  } finally {
    connecting = false;
  }
}

async function observeTunnel(tunnel: SshTunnel, profileName: string): Promise<void> {
  const exit = await tunnel.exited;
  logger[exit.stopRequested ? "info" : "warn"]({
    event: "ssh.tunnel_exited",
    code: exit.code,
    signal: exit.signal,
    stopRequested: exit.stopRequested,
  }, exit.stopRequested ? "SSH tunnel stopped" : "SSH tunnel exited unexpectedly");

  if (activeTunnel !== tunnel) return;
  activeTunnel = undefined;
  if (shuttingDown || window.isClosed()) return;

  startupNotice = `与“${profileName}”的 SSH 连接已断开，请检查网络后重试。`;
  bindShell();
  window.navigate(shellUrl);
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ event: "app.shutdown" }, "DSH Desktop is shutting down");
  const tunnel = activeTunnel;
  activeTunnel = undefined;
  await tunnel?.stop();
  releaseWindowIcon?.();
  releaseWindowIcon = undefined;
  logger.info({ event: "app.stopped" }, "DSH Desktop stopped cleanly");
  logger.flush();
  closeAllowed = true;
  if (!window.isClosed()) window.close();
}

function resolveShellUrl(): string {
  const address = Deno.env.get("DENO_SERVE_ADDRESS");
  const port = address?.split(":").at(-1);
  if (!port || !/^\d+$/u.test(port)) {
    throw new Error("Deno Desktop did not provide a local serving address");
  }
  return `http://127.0.0.1:${port}/`;
}
