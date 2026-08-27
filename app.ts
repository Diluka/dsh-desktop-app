import { resolveAppPaths } from "./src/app_paths.ts";
import { readProcessOutputTail, spawnHiddenProcess } from "./src/hidden_process.ts";
import {
  LocalDshError,
  localDshInstallError,
  type LocalDshWeb,
  probeLocalDshEnvironment,
  startLocalDshWeb,
} from "./src/local_dsh.ts";
import { createLogger } from "./src/logger.ts";
import { openDirectory } from "./src/open_directory.ts";
import { ProfileStore, type ServerProfileInput } from "./src/profiles.ts";
import { probeOpenSsh, SshTunnel, startSshTunnel, TunnelError } from "./src/ssh_tunnel.ts";
import { handleShellRequest } from "./src/ui.ts";
import { setWindowsWindowIcon } from "./src/windows_window_icon.ts";

export type DesktopBackend = "cef" | "webview";

interface ShellServer {
  readonly addr: Deno.NetAddr;
  shutdown(): Promise<void>;
}

export async function startDesktop(backend: DesktopBackend): Promise<void> {
  const shellServer = Deno.serve({ hostname: "127.0.0.1", port: 0 }, handleShellRequest);
  try {
    await startDesktopWithShellServer(backend, shellServer);
  } catch (error) {
    await shellServer.shutdown();
    throw error;
  }
}

async function startDesktopWithShellServer(
  backend: DesktopBackend,
  shellServer: ShellServer,
): Promise<void> {
  const shellUrl = resolveShellUrl(shellServer.addr);
  const paths = resolveAppPaths();
  const logger = await createLogger(paths.logDirectory);
  const spawnChild = (command: string, args: string[]) =>
    spawnHiddenProcess(command, args, paths.logDirectory);
  logger.info({
    event: "app.start",
    version: Deno.version.deno,
    os: Deno.build.os,
    arch: Deno.build.arch,
    backend,
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

  const environmentReady = Promise.all([
    probeOpenSsh(),
    probeLocalDshEnvironment(),
  ]).then(([ssh, localDshEnvironment]) => {
    const localDshLauncher = localDshEnvironment.launcher;
    logger.info({
      event: "ssh.probe",
      available: ssh.available,
      version: ssh.version ?? "unknown",
    }, ssh.available ? "OpenSSH Client is available" : "OpenSSH Client is unavailable");
    logger.info({
      event: "local_dsh.probe",
      available: Boolean(localDshLauncher),
      launcher: localDshLauncher?.kind ?? "unavailable",
      loginShell: Deno.build.os === "windows"
        ? "not-applicable"
        : Deno.env.get("SHELL") ?? (Deno.build.os === "darwin" ? "/bin/zsh" : "/bin/sh"),
      nodeVersion: localDshEnvironment.node?.version ?? "unavailable",
      nodeCommand: localDshEnvironment.node?.command ?? "unavailable",
      dshVersion: localDshEnvironment.dsh?.version ?? "unavailable",
      dshCommand: localDshEnvironment.dsh?.command ?? "unavailable",
      npxVersion: localDshEnvironment.npx?.version ?? "unavailable",
      npxCommand: localDshEnvironment.npx?.command ?? "unavailable",
    }, localDshLauncher ? "Local DSH launcher is available" : "Local DSH launcher is unavailable");
    return { ssh, localDshEnvironment, localDshLauncher };
  });

  const iconLookupTitle = Deno.build.os === "windows" ? `DSH Desktop ${Deno.pid}` : "DSH Desktop";
  const window = backend === "webview"
    ? new Deno.BrowserWindow()
    : new Deno.BrowserWindow({ title: iconLookupTitle });
  if (backend === "webview") {
    window.addEventListener("load", () => window.setTitle("DSH Desktop"));
  }
  let releaseWindowIcon: (() => void) | undefined;
  if (Deno.build.os === "windows" && backend === "cef") {
    try {
      releaseWindowIcon = setWindowsWindowIcon(iconLookupTitle);
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
  let activeLocal: LocalDshWeb | undefined;
  let localStartController: AbortController | undefined;
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
    window.bind("bootstrap", async () => {
      const { ssh, localDshEnvironment, localDshLauncher } = await environmentReady;
      return {
        profiles: store.list(),
        mode: store.connectionMode(),
        ssh,
        localEnvironment: {
          platform: `${Deno.build.os} ${Deno.build.arch}`,
          nodeVersion: localDshEnvironment.node?.version,
          dshVersion: localDshEnvironment.dsh?.version,
          npxVersion: localDshEnvironment.npx?.version,
          launcher: localDshLauncher?.kind,
          canStart: Boolean(localDshLauncher),
        },
        logDirectory: paths.logDirectory,
        browserBackend: backend === "webview" ? "Microsoft Edge WebView2" : "Chromium / CEF",
        ...(startupNotice ? { startupNotice } : {}),
      };
    });
    window.bind("saveProfile", async (input: ServerProfileInput) => {
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
        logger.error(
          { event: "profiles.save_failed", err: error },
          "Failed to save server profile",
        );
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
    window.bind("setModePreference", async (mode: unknown) => {
      await store.setConnectionMode(mode);
      return null;
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
    window.bind("connectLocal", async () => {
      await connectLocal();
      return null;
    });
    window.bind("cancelLocalStart", () => {
      const controller = localStartController;
      if (!controller) return Promise.resolve(false);
      controller.abort();
      return Promise.resolve(true);
    });
    shellBindingsActive = true;
  }

  function unbindShell(): void {
    if (!shellBindingsActive) return;
    window.unbind("bootstrap");
    window.unbind("saveProfile");
    window.unbind("deleteProfile");
    window.unbind("setModePreference");
    window.unbind("openLogDirectory");
    window.unbind("connectProfile");
    window.unbind("connectLocal");
    window.unbind("cancelLocalStart");
    shellBindingsActive = false;
  }

  async function connectProfile(id: unknown): Promise<void> {
    if (connecting) throw new Error("已有连接正在建立，请稍候");
    const { ssh } = await environmentReady;
    if (!ssh.available) throw new Error(ssh.installHelp ?? "未找到 OpenSSH Client");
    if (typeof id !== "string") throw new Error("服务器 ID 无效");

    const profile = store.get(id);
    if (!profile) throw new Error("服务器配置不存在或已被删除");
    try {
      await store.markUsed(id);
    } catch (error) {
      logger.warn(
        { event: "profiles.last_used_failed", profileId: id, err: error },
        "Could not persist the last used server profile",
      );
    }
    connecting = true;
    try {
      if (activeLocal) {
        await activeLocal.stop();
        activeLocal = undefined;
      }
      if (activeTunnel) await activeTunnel.stop();
      const tunnel = await startSshTunnel(profile, logger, { spawn: spawnChild });
      activeTunnel = tunnel;

      // The DSH Web page must not inherit privileged bindings from the local selector.
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

  async function connectLocal(): Promise<void> {
    if (connecting) throw new Error("已有连接正在建立，请稍候");
    const { localDshLauncher } = await environmentReady;
    if (!localDshLauncher) throw localDshInstallError();
    const controller = new AbortController();
    localStartController = controller;
    connecting = true;
    try {
      if (activeTunnel) {
        await activeTunnel.stop();
        activeTunnel = undefined;
      }
      if (activeLocal) {
        await activeLocal.stop();
        activeLocal = undefined;
      }
      if (localDshLauncher.kind === "npx") {
        logger.warn(
          { event: "local_dsh.npx_fallback", command: localDshLauncher.command },
          "Local dsh command was unavailable; using npx",
        );
      }
      const local = await startLocalDshWeb(logger, localDshLauncher, {
        spawn: spawnChild,
        signal: controller.signal,
      });
      activeLocal = local;

      // The DSH Web page must not inherit privileged bindings from the local selector.
      unbindShell();
      try {
        window.navigate(local.url);
      } catch (error) {
        bindShell();
        activeLocal = undefined;
        await local.stop();
        throw error;
      }
      void observeLocal(local);
    } catch (error) {
      if (error instanceof LocalDshError && error.code === "START_CANCELLED") {
        logger.info({ event: "local_dsh.start_cancelled" }, "Local DSH Web start was cancelled");
        throw error;
      }
      if (
        localDshLauncher.kind === "npx" && error instanceof LocalDshError &&
        error.code === "DSH_WEB_FAILED"
      ) {
        logger.warn({ event: "local_dsh.npx_failed", err: error }, "npx launcher failed");
        throw localDshInstallError();
      }
      logger.error(
        { event: "local_dsh.connect_failed", err: error },
        "Failed to start local DSH Web",
      );
      if (error instanceof LocalDshError) throw error;
      throw new Error("本地 DSH Web 启动失败，详细信息已写入日志");
    } finally {
      if (localStartController === controller) localStartController = undefined;
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
      childOutputFile: tunnel.outputFile,
      ...(exit.error ? { err: exit.error } : {}),
    }, exit.stopRequested ? "SSH tunnel stopped" : "SSH tunnel exited unexpectedly");

    if (exit.stopRequested) return;
    if (activeTunnel !== tunnel) return;
    activeTunnel = undefined;
    if (shuttingDown || window.isClosed()) return;

    const detail = lastOutputLine(await readProcessOutputTail(tunnel.outputFile));
    startupNotice = detail
      ? `与“${profileName}”的 SSH 连接已断开：${detail}`
      : `与“${profileName}”的 SSH 连接已断开，请检查网络后重试。`;
    bindShell();
    window.navigate(shellUrl);
  }

  async function observeLocal(local: LocalDshWeb): Promise<void> {
    const exit = await local.exited;
    logger[exit.stopRequested ? "info" : "warn"]({
      event: "local_dsh.exited",
      code: exit.code,
      signal: exit.signal,
      stopRequested: exit.stopRequested,
      childOutputFile: local.outputFile,
      ...(exit.error ? { err: exit.error } : {}),
    }, exit.stopRequested ? "Local DSH Web stopped" : "Local DSH Web exited unexpectedly");

    if (exit.stopRequested) return;
    if (activeLocal !== local) return;
    activeLocal = undefined;
    if (shuttingDown || window.isClosed()) return;

    const detail = lastOutputLine(await readProcessOutputTail(local.outputFile));
    startupNotice = detail ? `本地 DSH Web 已退出：${detail}` : "本地 DSH Web 已退出，请重新启动。";
    bindShell();
    window.navigate(shellUrl);
  }

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: "app.shutdown" }, "DSH Desktop is shutting down");
    localStartController?.abort();
    localStartController = undefined;
    const tunnel = activeTunnel;
    const local = activeLocal;
    activeTunnel = undefined;
    activeLocal = undefined;
    await tunnel?.stop();
    await local?.stop();
    await shellServer.shutdown();
    releaseWindowIcon?.();
    releaseWindowIcon = undefined;
    logger.info({ event: "app.stopped" }, "DSH Desktop stopped cleanly");
    logger.flush();
    closeAllowed = true;
    if (!window.isClosed()) window.close();
  }
}

function lastOutputLine(detail?: string): string | undefined {
  const line = detail?.split(/\r?\n/u).at(-1)?.trim();
  return line ? line.slice(0, 500) : undefined;
}

function resolveShellUrl(address: Deno.NetAddr): string {
  return `http://127.0.0.1:${address.port}/`;
}
