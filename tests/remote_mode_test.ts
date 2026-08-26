import {
  assert,
  assertEquals,
  assertExists,
  assertFalse,
  assertMatch,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { basename, join } from "node:path";
import { resolveAppPaths } from "../src/app_paths.ts";
import { canonicalSystemLocale, detectSystemLocale } from "../src/browser_locale.ts";
import { createLogger } from "../src/logger.ts";
import { directoryOpenCommand } from "../src/open_directory.ts";
import { DEFAULT_REMOTE_PORT, ProfileStore, ProfileValidationError } from "../src/profiles.ts";
import { buildSshArguments, probeOpenSsh, startSshTunnel, TunnelError } from "../src/ssh_tunnel.ts";
import SHELL_HTML from "../src/ui.html" with { type: "text" };
import { handleShellRequest } from "../src/ui.ts";
import { setWindowsWindowIcon } from "../src/windows_window_icon.ts";

const LOG_FILE_PATTERN = /^dsh-desktop-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{9}Z\.jsonl$/u;

function env(values: Record<string, string | undefined>): (name: string) => string | undefined {
  return (name) => values[name];
}

async function tempFile(name: string): Promise<string> {
  const directory = await Deno.makeTempDir();
  return join(directory, name);
}

Deno.test("resolveAppPaths uses the native platform path rules", () => {
  if (Deno.build.os === "windows") {
    assertEquals(
      resolveAppPaths(env({
        USERPROFILE: "C:\\Users\\Alice",
        APPDATA: "C:\\Users\\Alice\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local",
      })),
      {
        configFile: "C:\\Users\\Alice\\AppData\\Roaming\\dsh-desktop\\servers.json",
        logDirectory: "C:\\Users\\Alice\\AppData\\Local\\dsh-desktop\\logs",
      },
    );
    return;
  }

  if (Deno.build.os === "darwin") {
    assertEquals(resolveAppPaths(env({ HOME: "/Users/alice" })), {
      configFile: "/Users/alice/Library/Application Support/dsh-desktop/servers.json",
      logDirectory: "/Users/alice/Library/Logs/dsh-desktop",
    });
    return;
  }

  assertEquals(
    resolveAppPaths(env({
      HOME: "/home/alice",
      XDG_CONFIG_HOME: "/cfg",
      XDG_STATE_HOME: "/state",
    })),
    {
      configFile: "/cfg/dsh-desktop/servers.json",
      logDirectory: "/state/dsh-desktop/logs",
    },
  );
  assertEquals(resolveAppPaths(env({ HOME: "/home/alice" })), {
    configFile: "/home/alice/.config/dsh-desktop/servers.json",
    logDirectory: "/home/alice/.local/state/dsh-desktop/logs",
  });
});

Deno.test("system locale normalization uses runtime values", () => {
  assertEquals(canonicalSystemLocale("zh_CN"), "zh-CN");
  assertEquals(canonicalSystemLocale("not a locale"), undefined);
  const detected = detectSystemLocale();
  if (detected) assertEquals(canonicalSystemLocale(detected), detected);
});

Deno.test("Windows native icon API uses the scoped user32 permission", () => {
  if (Deno.build.os !== "windows") return;
  assertThrows(
    () => setWindowsWindowIcon(`missing-window-${crypto.randomUUID()}`),
    Error,
    "Native window was not found",
  );
});

Deno.test("directoryOpenCommand uses each platform's standard file manager", () => {
  assertEquals(directoryOpenCommand("windows", "C:\\logs"), {
    command: "explorer.exe",
    args: ["C:\\logs"],
  });
  assertEquals(directoryOpenCommand("darwin", "/Users/alice/Logs"), {
    command: "open",
    args: ["/Users/alice/Logs"],
  });
  assertEquals(directoryOpenCommand("linux", "/home/alice/logs"), {
    command: "xdg-open",
    args: ["/home/alice/logs"],
  });
});

Deno.test("ProfileStore defaults port, validates input, persists and deletes", async () => {
  const filePath = await tempFile("servers.json");
  const { store } = await ProfileStore.open(filePath, { createId: () => "profile-1" });

  const saved = await store.save({ name: "", sshTarget: " prod-dsh " });
  assertEquals(saved, {
    id: "profile-1",
    name: "prod-dsh",
    sshTarget: "prod-dsh",
    remotePort: DEFAULT_REMOTE_PORT,
  });
  assertEquals(JSON.parse(await Deno.readTextFile(filePath)).profiles, [saved]);

  await assertRejects(
    () => store.save({ name: "bad", sshTarget: "-oProxyCommand=evil", remotePort: 3080 }),
    ProfileValidationError,
  );
  await assertRejects(
    () => store.save({ name: "bad", sshTarget: "prod dsh", remotePort: 3080 }),
    ProfileValidationError,
  );
  await assertRejects(
    () => store.save({ name: "bad", sshTarget: "prod", remotePort: 65536 }),
    ProfileValidationError,
  );
  await assertRejects(
    () => store.delete(123),
    ProfileValidationError,
  );

  assertEquals(await store.delete("profile-1"), true);
  assertEquals(store.list(), []);
  assertEquals(JSON.parse(await Deno.readTextFile(filePath)).profiles, []);
  assertEquals(await store.delete("missing"), false);
});

Deno.test("ProfileStore backs up corrupt config and recovers empty store", async () => {
  const filePath = await tempFile("servers.json");
  await Deno.writeTextFile(filePath, "not json");

  const opened = await ProfileStore.open(filePath, {
    now: () => new Date("2025-01-02T03:04:05.000Z"),
  });

  assertEquals(opened.store.list(), []);
  assertEquals(opened.recoveredBackup, `${filePath}.invalid-2025-01-02T03-04-05.000Z`);
  assertEquals(await Deno.readTextFile(opened.recoveredBackup!), "not json");
  await assertRejects(() => Deno.readTextFile(filePath), Deno.errors.NotFound);
});

Deno.test("buildSshArguments creates non-interactive loopback forwarding without clearing forwards", () => {
  const args = buildSshArguments({
    id: "p1",
    name: "Production",
    sshTarget: "prod-dsh",
    remotePort: 48080,
  }, 39001);

  assert(args.includes("-N"));
  assert(args.includes("-T"));
  assert(args.includes("BatchMode=yes"));
  assert(args.includes("ExitOnForwardFailure=yes"));
  assert(args.includes("-L"));
  assert(args.includes("127.0.0.1:39001:127.0.0.1:48080"));
  assertFalse(args.some((value) => /ClearAllForwardings/i.test(value)));
  assertFalse(args.some((value) => /StrictHostKeyChecking/i.test(value)));
  assertEquals(args.at(-2), "--");
  assertEquals(args.at(-1), "prod-dsh");
});

Deno.test("probeOpenSsh reports platform install help when command is missing", async () => {
  const missingCommand = `missing-ssh-${crypto.randomUUID()}`;

  const windows = await probeOpenSsh("windows", missingCommand);
  assertEquals(windows.available, false);
  assertMatch(windows.installHelp ?? "", /Windows.*OpenSSH/u);

  const linux = await probeOpenSsh("linux", missingCommand);
  assertEquals(linux.available, false);
  assertMatch(linux.installHelp ?? "", /openssh-client/u);

  const macos = await probeOpenSsh("darwin", missingCommand);
  assertEquals(macos.available, false);
  assertMatch(macos.installHelp ?? "", /macOS PATH/u);
});

Deno.test("startSshTunnel supports fake child ready path and stop lifecycle", async () => {
  const { logger } = await memoryLogger();
  let capturedCommand = "";
  let capturedArgs: string[] = [];
  const child = fakeChild();

  const tunnel = await startSshTunnel(profile(), logger, {
    command: "fake-ssh",
    allocatePort: () => Promise.resolve(41000),
    spawn: (command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return child;
    },
    probe: (url) => {
      assertEquals(url, "http://127.0.0.1:41000/");
      return Promise.resolve();
    },
    now: () => 1000,
  });

  assertEquals(tunnel.url, "http://127.0.0.1:41000/");
  assertEquals(capturedCommand, "fake-ssh");
  assertEquals(capturedArgs.at(-1), "prod-dsh");

  const stopped = tunnel.stop();
  assertEquals(child.kills, ["SIGTERM"]);
  child.finish({ success: true, code: 0, signal: null });
  await stopped;
  assertEquals(await tunnel.exited, {
    success: true,
    code: 0,
    signal: null,
    stderr: [],
    stopRequested: true,
  });
});

Deno.test("startSshTunnel classifies auth failure without logging private key material", async () => {
  const child = fakeChild(
    "-----BEGIN OPENSSH PRIVATE KEY-----\nsecretbase64\n-----END OPENSSH PRIVATE KEY-----\nPermission denied (publickey).\n",
  );
  child.finish({ success: false, code: 255, signal: null });

  const { logger, filePath } = await memoryLogger();
  const error = await assertRejects(
    () =>
      startSshTunnel(profile(), logger, {
        allocatePort: () => Promise.resolve(41001),
        spawn: () => child,
        probe: () => Promise.reject(new Error("not ready")),
        delay: () => Promise.resolve(),
        now: tickingClock(0, 1000),
        startupTimeoutMs: 5000,
      }),
    TunnelError,
  );
  assertEquals(error.code, "AUTH_FAILED");
  logger.flush();
  const log = await Deno.readTextFile(filePath);
  assertFalse(log.includes("secretbase64"));
  assert(log.includes("[REDACTED PRIVATE KEY MATERIAL]"));
});

Deno.test("Pino writes standard JSONL fields and redacts sensitive values", async () => {
  const directory = await Deno.makeTempDir();
  const logger = await createLogger(directory);
  const filePath = await findLogFile(directory);

  const loggedError = Object.assign(new TypeError("boom"), { token: "nested-secret" });
  logger.error({
    event: "ssh.failed",
    detail: `password=hunter2 Authorization: Bearer abc123 ${"y".repeat(4100)}`,
    token: "should-never-be-written",
    err: loggedError,
  }, "Failed to connect");
  logger.error({ event: "app.unhandled_rejection", err: "token=reason-secret" }, "Rejected");
  logger.flush();

  assertMatch(basename(filePath), LOG_FILE_PATTERN);
  const lines = (await Deno.readTextFile(filePath)).trimEnd().split("\n");
  assertEquals(lines.length, 2);
  const entry = JSON.parse(lines[0]);
  assertFalse(Number.isNaN(Date.parse(entry.time)));
  assertEquals(entry.level, 50);
  assertEquals(entry.pid, Deno.pid);
  assertEquals(entry.event, "ssh.failed");
  assertEquals(entry.msg, "Failed to connect");
  assertEquals(entry.token, "[REDACTED]");
  assertEquals(entry.detail.length, 4003);
  assertFalse(entry.detail.includes("hunter2"));
  assertFalse(entry.detail.includes("abc123"));
  assertEquals(entry.err.type, "TypeError");
  assertEquals(entry.err.message, "boom");
  assertEquals(entry.err.token, "[REDACTED]");
  assertExists(entry.err.stack);

  const rejection = JSON.parse(lines[1]);
  assertEquals(rejection.event, "app.unhandled_rejection");
  assertEquals(rejection.err, "token=[REDACTED]");
});

Deno.test("Pino creates a separate file for each logger", async () => {
  const directory = await Deno.makeTempDir();
  const first = await createLogger(directory);
  const second = await createLogger(directory);
  first.info({ event: "session.first" }, "First session");
  second.info({ event: "session.second" }, "Second session");
  first.flush();
  second.flush();

  const files = await findLogFiles(directory);
  assertEquals(files.length, 2);
  const contents = await Promise.all(files.map((file) => Deno.readTextFile(file)));
  assert(contents.some((content) => content.includes('"event":"session.first"')));
  assert(contents.some((content) => content.includes('"event":"session.second"')));
  assertFalse(
    contents.some((content) =>
      content.includes('"event":"session.first"') && content.includes('"event":"session.second"')
    ),
  );
});

Deno.test("handleShellRequest serves safe shell responses without local tunnel internals", async () => {
  const get = handleShellRequest(new Request("http://desktop.local/"));
  assertEquals(get.status, 200);
  assertEquals(get.headers.get("content-type"), "text/html; charset=utf-8");
  assertEquals(get.headers.get("cache-control"), "no-store");
  assertEquals(get.headers.get("x-content-type-options"), "nosniff");
  assertEquals(get.headers.get("referrer-policy"), "no-referrer");
  assertEquals(
    get.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  );
  assertEquals(await get.text(), SHELL_HTML);

  const head = handleShellRequest(new Request("http://desktop.local/", { method: "HEAD" }));
  assertEquals(head.status, 200);
  assertEquals(await head.text(), "");

  assertEquals(handleShellRequest(new Request("http://desktop.local/nope")).status, 404);
  assertEquals(
    handleShellRequest(new Request("http://desktop.local/", { method: "POST" })).status,
    404,
  );

  assertFalse(SHELL_HTML.includes("http://127.0.0.1:"));
  assertFalse(SHELL_HTML.includes("localhost:"));
  assertFalse(SHELL_HTML.includes("localPort"));
  assertFalse(SHELL_HTML.includes("tunnel.url"));
});

function profile() {
  return { id: "p1", name: "Production", sshTarget: "prod-dsh", remotePort: 3080 };
}

async function memoryLogger() {
  const directory = await Deno.makeTempDir();
  const logger = await createLogger(directory);
  return { logger, filePath: await findLogFile(directory) };
}

async function findLogFile(directory: string): Promise<string> {
  const [file] = await findLogFiles(directory);
  if (!file) throw new Error("Pino log file was not created");
  return file;
}

async function findLogFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isFile && LOG_FILE_PATTERN.test(entry.name)) files.push(join(directory, entry.name));
  }
  return files;
}

function tickingClock(initial: number, step: number): () => number {
  let value = initial;
  return () => {
    const current = value;
    value += step;
    return current;
  };
}

function fakeChild(stderr = "") {
  let finish!: (status: Deno.CommandStatus) => void;
  const status = new Promise<Deno.CommandStatus>((resolve) => {
    finish = resolve;
  });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (stderr) controller.enqueue(encoder.encode(stderr));
      controller.close();
    },
  });
  const child = {
    status,
    stderr: stream,
    kills: [] as Array<Deno.Signal | undefined>,
    kill(signal?: Deno.Signal) {
      this.kills.push(signal);
    },
    finish,
  };
  return child;
}
