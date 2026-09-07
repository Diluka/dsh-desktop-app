import { resolveAppPaths } from "./src/app_paths.ts";
import { BUILD_COMMIT } from "./src/build_info.ts";
import { readProcessOutputTail, spawnHiddenProcess } from "./src/hidden_process.ts";
import {
  LocalDshError,
  localDshInstallError,
  type LocalDshWeb,
  probeLocalDshEnvironment,
  startLocalDshWeb,
} from "./src/local_dsh.ts";
import { createLogger } from "./src/logger.ts";
import { openDirectory, openExternalUrl } from "./src/open_directory.ts";
import { ProfileStore, type ServerProfile, type ServerProfileInput } from "./src/profiles.ts";
import { reconnectSshTunnel, type SshReconnectProgress } from "./src/ssh_reconnect.ts";
import { recoverRemoteDshWebToken } from "./src/remote_dsh_token_probe.ts";
import { probeOpenSsh, SshTunnel, startSshTunnel, TunnelError } from "./src/ssh_tunnel.ts";
import { checkForUpdate, UPDATE_RELEASE_URL } from "./src/updater.ts";
import { handleShellRequest } from "./src/ui.ts";
import { setWindowsWindowIcon } from "./src/windows_window_icon.ts";

export type DesktopBackend = "cef" | "webview";

interface ReconnectState {
  readonly profileId: string;
  readonly profileName: string;
  readonly active: boolean;
  readonly message: string;
  readonly errorCode?: string;
}

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
    buildCommit: BUILD_COMMIT,
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
  let remoteStartController: AbortController | undefined;
  let reconnectController: AbortController | undefined;
  let reconnectTask: Promise<void> | undefined;
  let reconnectState: ReconnectState | undefined;
  let connecting = false;
  let connectionTask: Promise<void> | undefined;
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
          powershell: localDshEnvironment.powershell,
          launcher: localDshLauncher?.kind,
          canStart: Boolean(localDshLauncher),
        },
        logDirectory: paths.logDirectory,
        buildCommit: BUILD_COMMIT,
        updatesSupported: BUILD_COMMIT !== "development" && Deno.build.os !== "linux",
        browserBackend: backend === "webview" ? "Microsoft Edge WebView2" : "Chromium / CEF",
        ...(startupNotice ? { startupNotice } : {}),
        reconnect: reconnectState,
      };
    });
    window.bind("getReconnectState", () => Promise.resolve(reconnectState ?? null));
    window.bind("cancelReconnect", async () => {
      await cancelReconnect();
      return null;
    });
    window.bind("saveProfile", async (input: ServerProfileInput) => {
      try {
        if (input.id === reconnectState?.profileId) await cancelReconnect();
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
      if (id === reconnectState?.profileId) await cancelReconnect();
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
      if (mode === "local") await cancelReconnect();
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
    window.bind("checkForUpdate", async () => {
      ensureUpdatesSupported();
      try {
        const update = await checkForUpdate(BUILD_COMMIT);
        logger.info({ event: "update.checked", ...update }, "Checked for desktop updates");
        return update;
      } catch (error) {
        logger.warn(
          { event: "update.check_failed", err: error },
          "Could not check for desktop updates",
        );
        throw updateError(error, "检查更新失败");
      }
    });
    window.bind("openUpdateReleasePage", async () => {
      try {
        await openExternalUrl(UPDATE_RELEASE_URL);
        logger.info({ event: "update.release_page_opened" }, "Opened the update release page");
        return null;
      } catch (error) {
        logger.error(
          { event: "update.release_page_open_failed", err: error },
          "Failed to open the update release page",
        );
        throw updateError(error, "无法打开下载页面");
      }
    });
    window.bind("connectProfile", async (id: unknown) => {
      await runConnection(() => connectProfile(id));
      return null;
    });
    window.bind("connectLocal", async () => {
      await runConnection(connectLocal);
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
    window.unbind("getReconnectState");
    window.unbind("cancelReconnect");
    window.unbind("saveProfile");
    window.unbind("deleteProfile");
    window.unbind("setModePreference");
    window.unbind("openLogDirectory");
    window.unbind("checkForUpdate");
    window.unbind("openUpdateReleasePage");
    window.unbind("connectProfile");
    window.unbind("connectLocal");
    window.unbind("cancelLocalStart");
    shellBindingsActive = false;
  }

  function ensureUpdatesSupported(): void {
    if (BUILD_COMMIT === "development") {
      throw new Error("开发构建没有发布 commit id，无法检查更新");
    }
  }

  async function runConnection(start: () => Promise<void>): Promise<void> {
    if (shuttingDown) throw new Error("应用正在退出");
    if (connecting) throw new Error("已有连接正在建立，请稍候");
    const task = start();
    connectionTask = task;
    try {
      await task;
    } finally {
      if (connectionTask === task) connectionTask = undefined;
    }
  }

  async function connectProfile(id: unknown): Promise<void> {
    if (shuttingDown) throw new Error("应用正在退出");
    if (connecting) throw new Error("已有连接正在建立，请稍候");
    if (typeof id !== "string") throw new Error("服务器 ID 无效");
    connecting = true;
    const controller = new AbortController();
    remoteStartController = controller;
    try {
      await cancelReconnect();
      const { ssh } = await environmentReady;
      controller.signal.throwIfAborted();
      if (!ssh.available) throw new Error(ssh.installHelp ?? "未找到 OpenSSH Client");
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
      if (activeLocal) {
        await activeLocal.stop();
        activeLocal = undefined;
      }
      if (activeTunnel) {
        const previous = activeTunnel;
        activeTunnel = undefined;
        await previous.stop();
      }
      controller.signal.throwIfAborted();
      const tunnel = await openRemoteTunnel(profile, controller.signal);
      await activateTunnel(tunnel, profile, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw error;
      logger.error({
        event: "ssh.connect_failed",
        profileId: id,
        err: error,
      }, "Failed to connect a server profile");
      if (error instanceof TunnelError) throw error;
      throw new Error("连接失败，详细信息已写入日志");
    } finally {
      if (remoteStartController === controller) remoteStartController = undefined;
      connecting = false;
    }
  }

  async function openRemoteTunnel(profile: ServerProfile, signal: AbortSignal): Promise<SshTunnel> {
    let recovered: Awaited<ReturnType<typeof recoverRemoteDshWebToken>>;
    const tunnel = await startSshTunnel(profile, logger, {
      spawn: spawnChild,
      signal,
      recoverToken: async ({ localPort }) => {
        const candidate = await recoverRemoteDshWebToken(profile, localPort, { signal });
        if (signal.aborted) return undefined;
        recovered = candidate;
        return candidate;
      },
    });
    // Persist outside the cancellable probe callback: a late probe must never
    // resurrect a deleted profile or overwrite an edited token after cancellation.
    if (recovered && !signal.aborted) {
      try {
        await store.save({ ...profile, dshWebToken: recovered.token });
        logger.info({
          event: "profiles.dsh_token_recovered",
          profileId: profile.id,
          sourceId: recovered.sourceId,
        }, "Recovered remote DSH Web token was saved");
      } catch (error) {
        logger.warn({
          event: "profiles.dsh_token_recovered_save_failed",
          profileId: profile.id,
          sourceId: recovered.sourceId,
          err: error,
        }, "Recovered remote DSH Web token could not be saved");
      }
    }
    if (signal.aborted) {
      await tunnel.stop();
      signal.throwIfAborted();
    }
    return tunnel;
  }

  async function activateTunnel(
    tunnel: SshTunnel,
    profile: ServerProfile,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted || shuttingDown || window.isClosed()) {
      await tunnel.stop();
      throw new DOMException("Connection cancelled", "AbortError");
    }
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
    startupNotice = undefined;
    reconnectState = undefined;
    void observeTunnel(tunnel, profile);
  }

  async function cancelReconnect(): Promise<void> {
    const controller = reconnectController;
    const task = reconnectTask;
    reconnectController = undefined;
    controller?.abort();
    await task;
    if (reconnectTask === task) {
      reconnectTask = undefined;
      reconnectState = undefined;
    }
  }

  function beginReconnect(profile: ServerProfile): void {
    const controller = new AbortController();
    reconnectController = controller;
    const onProgress = (progress: SshReconnectProgress) => {
      if (reconnectController !== controller) return;
      const prefix = `与“${profile.name}”的连接已断开。`;
      reconnectState = {
        profileId: profile.id,
        profileName: profile.name,
        active: true,
        message: progress.phase === "waiting"
          ? `${prefix}${
            progress.delayMs / 1000
          } 秒后自动重连（${progress.attempt}/${progress.maxAttempts}）`
          : `${prefix}正在重连（${progress.attempt}/${progress.maxAttempts}）…`,
      };
    };
    reconnectTask = (async () => {
      try {
        const tunnel = await reconnectSshTunnel(profile, logger, {
          signal: controller.signal,
          onProgress,
          start: (signal) => {
            const current = store.get(profile.id);
            if (!current) throw new Error("服务器配置已被删除");
            return openRemoteTunnel(current, signal);
          },
        });
        await activateTunnel(tunnel, profile, controller.signal);
        logger.info({ event: "ssh.reconnected", profileId: profile.id }, "SSH connection restored");
      } catch (error) {
        if (controller.signal.aborted || reconnectController !== controller) return;
        const detail = error instanceof TunnelError ? error.message : "详细信息已写入日志";
        reconnectState = {
          profileId: profile.id,
          profileName: profile.name,
          active: false,
          message: `与“${profile.name}”的自动重连已停止：${detail}。请检查后手动重试。`,
          ...(error instanceof TunnelError ? { errorCode: error.code } : {}),
        };
        logger.warn({
          event: "ssh.reconnect_stopped",
          profileId: profile.id,
          errorCode: error instanceof TunnelError ? error.code : "UNKNOWN",
        }, "Automatic SSH reconnection stopped");
      } finally {
        if (reconnectController === controller) {
          reconnectController = undefined;
          reconnectTask = undefined;
        }
      }
    })();
  }

  async function connectLocal(): Promise<void> {
    if (shuttingDown) throw new Error("应用正在退出");
    if (connecting) throw new Error("已有连接正在建立，请稍候");
    const controller = new AbortController();
    localStartController = controller;
    connecting = true;
    let localDshLauncher: Awaited<typeof environmentReady>["localDshLauncher"];
    try {
      await cancelReconnect();
      ({ localDshLauncher } = await environmentReady);
      if (controller.signal.aborted) throw new LocalDshError("START_CANCELLED", "启动已取消");
      if (!localDshLauncher) throw localDshInstallError();
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
      if (controller.signal.aborted || shuttingDown || window.isClosed()) {
        await local.stop();
        throw new LocalDshError("START_CANCELLED", "启动已取消");
      }
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
        localDshLauncher?.kind === "npx" && error instanceof LocalDshError &&
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

  async function observeTunnel(tunnel: SshTunnel, profile: ServerProfile): Promise<void> {
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
    if (shuttingDown || window.isClosed()) return;

    const detail = lastOutputLine(await readProcessOutputTail(tunnel.outputFile));
    // Reading the log can overlap shutdown or a new connection request.
    if (activeTunnel !== tunnel || shuttingDown || window.isClosed() || connecting) return;
    activeTunnel = undefined;
    startupNotice = detail
      ? `与“${profile.name}”的 SSH 连接已断开：${detail}`
      : `与“${profile.name}”的 SSH 连接已断开。`;
    bindShell();
    window.navigate(shellUrl);
    beginReconnect(profile);
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
    remoteStartController?.abort();
    await cancelReconnect();
    await connectionTask?.catch(() => undefined);
    localStartController = undefined;
    remoteStartController = undefined;
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

function updateError(error: unknown, prefix: string): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${prefix}：${detail}`);
}

function resolveShellUrl(address: Deno.NetAddr): string {
  return `http://127.0.0.1:${address.port}/`;
}
