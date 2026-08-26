import { resolveAppPaths } from "./src/app_paths.ts";
import { prepareSystemBrowserLocale } from "./src/browser_locale.ts";
import { errorContext, JsonlLogger } from "./src/logger.ts";
import { ProfileStore } from "./src/profiles.ts";
import { probeOpenSsh, SshTunnel, startSshTunnel, TunnelError } from "./src/ssh_tunnel.ts";
import { handleShellRequest } from "./src/ui.ts";

const browserLocale = await prepareSystemBrowserLocale();
if (browserLocale.relaunched) Deno.exit(0);

const paths = resolveAppPaths();
const logger = await JsonlLogger.create(paths.logDirectory);
await logger.info("app.start", "DSH Desktop is starting", {
  version: Deno.version.deno,
  os: Deno.build.os,
  arch: Deno.build.arch,
  ...(browserLocale.locale ? { browserLocale: browserLocale.locale } : {}),
});
if (browserLocale.error) {
  await logger.warn(
    "browser.locale_bootstrap_failed",
    "Could not relaunch Chromium with the system locale",
    errorContext(browserLocale.error),
  );
}

const { store, recoveredBackup } = await ProfileStore.open(paths.configFile);
let startupNotice = recoveredBackup
  ? `检测到损坏的服务器配置，原文件已保留为 ${recoveredBackup}`
  : undefined;
if (recoveredBackup) {
  await logger.warn("profiles.recovered", "Recovered from an invalid profile file", {
    backupPath: recoveredBackup,
  });
}

const ssh = await probeOpenSsh();
await logger.info(
  "ssh.probe",
  ssh.available ? "OpenSSH Client is available" : "OpenSSH Client is unavailable",
  { available: ssh.available, version: ssh.version ?? "unknown" },
);

const shellUrl = resolveShellUrl();
Deno.serve({ hostname: "127.0.0.1" }, handleShellRequest);
const window = new Deno.BrowserWindow({
  title: "DSH Desktop",
  width: 1180,
  height: 760,
});

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
  void logger.error("app.uncaught_error", "Uncaught application error", errorContext(event.error));
});
addEventListener("unhandledrejection", (event) => {
  void logger.error(
    "app.unhandled_rejection",
    "Unhandled application rejection",
    errorContext(event.reason),
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
      await logger.info("profiles.saved", "Server profile was saved", {
        profileId: profile.id,
        sshTarget: profile.sshTarget,
        remotePort: profile.remotePort,
      });
      return profile;
    } catch (error) {
      await logger.error(
        "profiles.save_failed",
        "Failed to save server profile",
        errorContext(error),
      );
      throw error;
    }
  });
  window.bind("deleteProfile", async (id: unknown) => {
    const deleted = await store.delete(id);
    if (deleted) {
      await logger.info("profiles.deleted", "Server profile was deleted", {
        profileId: String(id),
      });
    }
    return deleted;
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
    await logger.error("ssh.connect_failed", "Failed to connect a server profile", {
      profileId: profile.id,
      ...errorContext(error),
    });
    if (error instanceof TunnelError) throw error;
    throw new Error("连接失败，详细信息已写入日志");
  } finally {
    connecting = false;
  }
}

async function observeTunnel(tunnel: SshTunnel, profileName: string): Promise<void> {
  const exit = await tunnel.exited;
  await logger[exit.stopRequested ? "info" : "warn"](
    "ssh.tunnel_exited",
    exit.stopRequested ? "SSH tunnel stopped" : "SSH tunnel exited unexpectedly",
    {
      code: exit.code,
      signal: exit.signal,
      stopRequested: exit.stopRequested,
    },
  );

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
  await logger.info("app.shutdown", "DSH Desktop is shutting down");
  const tunnel = activeTunnel;
  activeTunnel = undefined;
  await tunnel?.stop();
  await logger.info("app.stopped", "DSH Desktop stopped cleanly");
  await logger.flush();
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
