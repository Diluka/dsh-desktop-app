import { resolveAppPaths } from "./src/app_paths.ts";
import { BUILD_COMMIT } from "./src/build_info.ts";
import { connectDshWeb, DshConnectionError } from "./src/dsh_connection.ts";
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
import {
  classifySshFailure,
  probeOpenSsh,
  SshTunnel,
  startSshTunnel,
  TunnelError,
} from "./src/ssh_tunnel.ts";
import { checkForUpdate, UPDATE_RELEASE_URL } from "./src/updater.ts";
import { handleShellRequest } from "./src/ui.ts";
import { setWindowsWindowIcon } from "./src/windows_window_icon.ts";

export type DesktopBackend = "cef" | "webview";

interface RemoteLayerState {
  readonly profileId: string;
  readonly profileName: string;
  readonly active: boolean;
  readonly message: string;
  readonly errorCode?: string;
}

interface RemoteConnection {
  profile: ServerProfile;
  readonly generation: number;
  tunnel?: SshTunnel;
  sshController?: AbortController;
  sshTask?: Promise<void>;
  observerTask?: Promise<void>;
  dshController?: AbortController;
  dshTask?: Promise<void>;
  dshGeneration: number;
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

  let remote: RemoteConnection | undefined;
  let remoteGeneration = 0;
  let remoteRequest = 0;
  let remoteStopTask: Promise<void> | undefined;
  let profileWriteTask: Promise<unknown> = Promise.resolve();
  let reconnectState: RemoteLayerState | undefined;
  let dshState: RemoteLayerState | undefined;
  let activeLocal: LocalDshWeb | undefined;
  let localStartController: AbortController | undefined;
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
        ...getRemoteConnectionState(),
      };
    });
    window.bind("getRemoteConnectionState", () => Promise.resolve(getRemoteConnectionState()));
    window.bind("cancelReconnect", async () => {
      await cancelReconnect();
      return null;
    });
    window.bind("retryDshConnection", async () => {
      const owner = remote;
      if (!owner || !ownsRemote(owner) || !owner.tunnel) {
        throw new Error("SSH 进程尚未运行，请先连接服务器");
      }
      // Start the independent task, but do not await its HTTP work.
      await startDshConnection(owner);
      return null;
    });
    window.bind("cancelDshConnection", async () => {
      const owner = remote;
      if (owner) await cancelDshConnection(owner);
      return null;
    });
    window.bind("saveProfile", async (input: ServerProfileInput) => {
      try {
        const owner = remote;
        if (owner && input.id === owner.profile.id) {
          if (remoteStopTask) await remoteStopTask;
          else await cancelDshConnection(owner);
        }
        const profile = await writeProfiles(() => store.save(input));
        if (owner && remote === owner && profile.id === owner.profile.id) {
          if (!sameEndpoint(owner.profile, profile)) {
            await cancelReconnect();
          } else {
            owner.profile = profile;
            // A process may have respawned while the profile write was pending.
            await cancelDshConnection(owner);
            if (reconnectState?.profileId === profile.id) {
              reconnectState = { ...reconnectState, profileName: profile.name };
            }
          }
        }
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
      if (id === remote?.profile.id) await cancelReconnect();
      const deleted = await writeProfiles(() => store.delete(id));
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
      await writeProfiles(() => store.setConnectionMode(mode));
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
      await connectProfile(id);
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
    window.unbind("getRemoteConnectionState");
    window.unbind("cancelReconnect");
    window.unbind("retryDshConnection");
    window.unbind("cancelDshConnection");
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

  function getRemoteConnectionState() {
    return {
      reconnect: reconnectState ?? null,
      dsh: dshState ?? null,
      remoteActive: Boolean(
        remote && (remote.tunnel || remote.sshTask || remote.dshTask || remote.observerTask),
      ),
    };
  }

  function ownsRemote(owner: RemoteConnection): boolean {
    return remote === owner && owner.generation === remoteGeneration &&
      !shuttingDown && !window.isClosed();
  }

  // Serialize persistence, not process supervision. Cancellation waits for any
  // already-authorized recovery write before a user's edit/delete can run.
  function writeProfiles<T>(write: () => Promise<T>): Promise<T> {
    const task = profileWriteTask.catch(() => undefined).then(write);
    profileWriteTask = task;
    return task;
  }

  async function connectProfile(id: unknown): Promise<void> {
    if (shuttingDown) throw new Error("应用正在退出");
    if (typeof id !== "string") throw new Error("服务器 ID 无效");
    const profile = store.get(id);
    if (!profile) throw new Error("服务器配置不存在或已被删除");
    const request = ++remoteRequest;
    const current = remote;
    if (
      current && ownsRemote(current) && current.tunnel && sameEndpoint(current.profile, profile)
    ) {
      current.profile = profile;
      startDshConnection(current);
      return;
    }
    await stopRemote();
    if (request !== remoteRequest || shuttingDown || window.isClosed()) return;
    localStartController?.abort();
    await connectionTask?.catch(() => undefined);
    if (request !== remoteRequest || shuttingDown || window.isClosed()) return;
    const owner: RemoteConnection = {
      profile,
      generation: ++remoteGeneration,
      dshGeneration: 0,
    };
    remote = owner;
    await startSshConnection(owner);
  }

  function startSshConnection(owner: RemoteConnection, exitFailure?: TunnelError): Promise<void> {
    const controller = new AbortController();
    owner.sshController = controller;
    reconnectState = {
      profileId: owner.profile.id,
      profileName: owner.profile.name,
      active: true,
      message: exitFailure
        ? `SSH 进程已退出：${exitFailure.message}。1 秒后重新启动…`
        : "正在启动 SSH 进程…",
      ...(exitFailure ? { errorCode: exitFailure.code } : {}),
    };
    const task = Promise.resolve().then(async () => {
      try {
        if (exitFailure) {
          await waitForSshReplacement(controller.signal);
        } else {
          const { ssh } = await environmentReady;
          controller.signal.throwIfAborted();
          if (!ssh.available) {
            throw new TunnelError("SSH_NOT_FOUND", ssh.installHelp ?? "未找到 OpenSSH Client");
          }
          await writeProfiles(async () => {
            if (!ownsRemote(owner) || controller.signal.aborted) return;
            try {
              await store.markUsed(owner.profile.id);
            } catch (error) {
              logger.warn(
                { event: "profiles.last_used_failed", err: error },
                "Could not save last profile",
              );
            }
          });
          if (activeLocal) {
            const previous = activeLocal;
            activeLocal = undefined;
            await previous.stop();
          }
        }
        controller.signal.throwIfAborted();
        const profile = store.get(owner.profile.id);
        if (!profile || !sameEndpoint(owner.profile, profile) || !ownsRemote(owner)) return;
        owner.profile = profile;
        const tunnel = await startSshTunnel(profile, logger, {
          spawn: spawnChild,
          signal: controller.signal,
        });
        if (!ownsRemote(owner) || controller.signal.aborted) {
          await tunnel.stop();
          return;
        }
        owner.tunnel = tunnel;
        // Observe the managed process before starting ANY independent DSH work.
        const observer = observeTunnel(owner, tunnel).finally(() => {
          if (owner.observerTask === observer) owner.observerTask = undefined;
        });
        owner.observerTask = observer;
        reconnectState = {
          profileId: owner.profile.id,
          profileName: owner.profile.name,
          active: false,
          message: "SSH 进程正在运行",
        };
        startDshConnection(owner);
      } catch (error) {
        if (!ownsRemote(owner) || controller.signal.aborted) return;
        reportSshFailure(owner, error);
      } finally {
        if (owner.sshController === controller) {
          owner.sshController = undefined;
          owner.sshTask = undefined;
        }
      }
    });
    owner.sshTask = task;
    return task;
  }

  function reportSshFailure(owner: RemoteConnection, error: unknown): void {
    reconnectState = {
      profileId: owner.profile.id,
      profileName: owner.profile.name,
      active: false,
      message: `SSH 进程连接已停止：${
        error instanceof TunnelError ? error.message : "详细信息已写入日志"
      }。请检查后手动重试。`,
      ...(error instanceof TunnelError ? { errorCode: error.code } : {}),
    };
    logger.warn({
      event: "ssh.connection_stopped",
      profileId: owner.profile.id,
      errorCode: error instanceof TunnelError ? error.code : "UNKNOWN",
    }, "SSH process connection stopped");
  }

  function startDshConnection(owner: RemoteConnection): void {
    if (!ownsRemote(owner) || !owner.tunnel) return;
    const tunnel = owner.tunnel;
    const savedProfile = store.get(owner.profile.id);
    if (!savedProfile || !sameEndpoint(owner.profile, savedProfile)) return;
    let profile: ServerProfile = savedProfile;
    const previous = owner.dshTask;
    owner.dshController?.abort();
    const controller = new AbortController();
    const generation = ++owner.dshGeneration;
    owner.dshController = controller;
    owner.profile = profile;
    const isCurrent = () => {
      const saved = store.get(owner.profile.id);
      return ownsRemote(owner) && owner.tunnel === tunnel &&
        owner.dshGeneration === generation && !controller.signal.aborted &&
        saved !== undefined && sameProfile(saved, profile);
    };
    dshState = {
      profileId: profile.id,
      profileName: profile.name,
      active: true,
      message: "SSH 进程正在运行，正在检查 DSH Web…",
    };
    const task = Promise.resolve().then(async () => {
      try {
        await previous;
        if (!isCurrent()) return;
        const result = await connectDshWeb(profile, tunnel.localPort, {
          signal: controller.signal,
        });
        if (!isCurrent()) return;
        if (result.recovered) {
          const recovered = result.recovered;
          await writeProfiles(async () => {
            if (!isCurrent()) return;
            try {
              profile = { ...profile, dshWebToken: recovered.token };
              await store.save(profile);
              if (isCurrent()) owner.profile = profile;
              logger.info({
                event: "profiles.dsh_token_recovered",
                profileId: profile.id,
                sourceId: recovered.sourceId,
              }, "Confirmed remote DSH Web token was saved");
            } catch (error) {
              logger.warn(
                { event: "profiles.dsh_token_recovered_save_failed", err: error },
                "Could not save recovered token",
              );
            }
          });
        }
        if (!isCurrent()) return;
        // Remote content must never receive selector/configuration bindings.
        unbindShell();
        try {
          window.navigate(result.url);
        } catch {
          showShell();
          throw new DshConnectionError(
            "DSH_UNAVAILABLE",
            "DSH Web 页面无法打开，请重试；SSH 进程仍在运行",
          );
        }
        startupNotice = undefined;
        dshState = {
          profileId: profile.id,
          profileName: profile.name,
          active: false,
          message: "DSH Web 已连接",
        };
      } catch (error) {
        if (!isCurrent()) return;
        dshState = {
          profileId: profile.id,
          profileName: profile.name,
          active: false,
          message: error instanceof DshConnectionError
            ? error.message
            : "DSH Web 检查失败；SSH 进程仍在运行，请重试",
          errorCode: error instanceof DshConnectionError ? error.code : "DSH_UNAVAILABLE",
        };
        logger.warn({
          event: "dsh.connection_failed",
          profileId: profile.id,
          errorCode: dshState.errorCode,
        }, "DSH check failed; SSH supervision remains active");
      } finally {
        if (owner.dshGeneration === generation) {
          owner.dshController = undefined;
          owner.dshTask = undefined;
        }
      }
    });
    owner.dshTask = task;
  }

  async function cancelDshConnection(owner: RemoteConnection): Promise<void> {
    const generation = ++owner.dshGeneration;
    const task = owner.dshTask;
    owner.dshController?.abort();
    if (ownsRemote(owner)) {
      dshState = owner.tunnel
        ? {
          profileId: owner.profile.id,
          profileName: owner.profile.name,
          active: false,
          message: "DSH Web 检查已取消；SSH 进程仍在运行，可重试",
        }
        : undefined;
    }
    await task;
    if (owner.dshGeneration === generation) {
      owner.dshController = undefined;
      owner.dshTask = undefined;
    }
  }

  async function cancelReconnect(): Promise<void> {
    ++remoteRequest;
    await stopRemote();
  }

  function stopRemote(): Promise<void> {
    if (remoteStopTask) return remoteStopTask;
    const owner = remote;
    if (!owner) return Promise.resolve();
    // Keep the owner discoverable until all cleanup completes. Concurrent edits,
    // deletes and stops must join this cleanup instead of bypassing it.
    ++remoteGeneration;
    owner.sshController?.abort();
    const dshCleanup = cancelDshConnection(owner);
    const task = Promise.resolve().then(async () => {
      await Promise.all([owner.sshTask, dshCleanup, owner.tunnel?.stop()]);
      await owner.observerTask;
      if (remote === owner) {
        remote = undefined;
        reconnectState = undefined;
        dshState = undefined;
      }
    }).finally(() => {
      if (remoteStopTask === task) remoteStopTask = undefined;
    });
    remoteStopTask = task;
    return task;
  }

  function showShell(): void {
    if (shuttingDown || window.isClosed()) return;
    bindShell();
    try {
      window.navigate(shellUrl);
    } catch (error) {
      logger.warn(
        { event: "shell.navigation_failed", err: error },
        "Could not show the connection selector",
      );
    }
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

  async function observeTunnel(owner: RemoteConnection, tunnel: SshTunnel): Promise<void> {
    const exit = await tunnel.exited;
    logger[exit.stopRequested ? "info" : "warn"]({
      event: "ssh.tunnel_exited",
      code: exit.code,
      signal: exit.signal,
      stopRequested: exit.stopRequested,
      childOutputFile: tunnel.outputFile,
      ...(exit.error ? { err: exit.error } : {}),
    }, exit.stopRequested ? "SSH tunnel stopped" : "SSH tunnel exited unexpectedly");
    if (exit.stopRequested || !ownsRemote(owner) || owner.tunnel !== tunnel) return;

    // Invalidate DSH results immediately, before log IO or auxiliary-process
    // cleanup. Login failure, a pending HTTP check, and manual DSH cancellation
    // have no bearing on whether this real process exit gets supervised.
    owner.tunnel = undefined;
    const previousStart = owner.sshTask;
    const dshCleanup = cancelDshConnection(owner);
    reconnectState = {
      profileId: owner.profile.id,
      profileName: owner.profile.name,
      active: true,
      message: "SSH 进程已退出，正在清理 DSH 检查并准备恢复…",
    };
    showShell();
    const [detail] = await Promise.all([
      readProcessOutputTail(tunnel.outputFile).catch(() => ""),
      dshCleanup,
      previousStart,
    ]);
    if (!ownsRemote(owner)) return;
    const failure = classifySshFailure(detail, exit.error);
    // The process wrapper reports asynchronous creation errors separately from
    // a real close status. Surface those for manual action, without a spawn loop.
    if (exit.error) {
      reportSshFailure(owner, failure);
      return;
    }
    // Classification is diagnostic only. Every unexpected exit follows the
    // same replacement rule; no DSH result can reach this entry point.
    void startSshConnection(owner, failure);
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
    await cancelReconnect();
    await connectionTask?.catch(() => undefined);
    await profileWriteTask.catch(() => undefined);
    localStartController = undefined;
    const local = activeLocal;
    activeLocal = undefined;
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

// Only a real, unexpected process exit schedules this short, cancellable wait.
function waitForSshReplacement(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("SSH replacement cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 1_000);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function sameEndpoint(left: ServerProfile, right: ServerProfile): boolean {
  return left.id === right.id && left.sshTarget === right.sshTarget &&
    left.remotePort === right.remotePort;
}

function sameProfile(left: ServerProfile, right: ServerProfile): boolean {
  return sameEndpoint(left, right) && left.name === right.name &&
    left.dshWebToken === right.dshWebToken;
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
