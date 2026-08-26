import { basename } from "node:path";
import { resolveAppPaths } from "../src/app_paths.ts";
import { errorContext, JsonlLogger } from "../src/logger.ts";
import { DEFAULT_REMOTE_PORT, ProfileStore, ProfileValidationError } from "../src/profiles.ts";
import { buildSshArguments, probeOpenSsh, startSshTunnel, TunnelError } from "../src/ssh_tunnel.ts";
import { handleShellRequest, SHELL_HTML } from "../src/ui.ts";

function env(values: Record<string, string | undefined>): (name: string) => string | undefined {
  return (name) => values[name];
}

async function tempFile(name: string): Promise<string> {
  const directory = await Deno.makeTempDir();
  return `${directory}/${name}`;
}

function assert(
  condition: unknown,
  message = "Expected condition to be truthy",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertFalse(condition: unknown, message = "Expected condition to be falsey"): void {
  if (condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
}

function assertMatch(actual: string, expected: RegExp): void {
  if (!expected.test(actual)) throw new Error(`Expected ${actual} to match ${expected}`);
}

function assertExists<T>(value: T | null | undefined): asserts value is T {
  if (value === null || value === undefined) throw new Error("Expected value to exist");
}

async function assertRejects<T extends Error>(
  action: () => Promise<unknown>,
  ErrorClass: new (...args: never[]) => T,
): Promise<T> {
  try {
    await action();
  } catch (error) {
    if (error instanceof ErrorClass) return error;
    throw new Error(`Expected ${ErrorClass.name}, got ${error}`);
  }
  throw new Error(`Expected ${ErrorClass.name} to be thrown`);
}

Deno.test("resolveAppPaths uses platform-specific config and state roots", () => {
  assertEquals(
    resolveAppPaths(
      "linux",
      env({
        HOME: "/home/alice",
        XDG_CONFIG_HOME: "/cfg",
        XDG_STATE_HOME: "/state",
      }),
    ),
    {
      configFile: "/cfg/dsh-desktop/servers.json",
      logDirectory: "/state/dsh-desktop/logs",
    },
  );

  assertEquals(resolveAppPaths("linux", env({ HOME: "/home/alice" })), {
    configFile: "/home/alice/.config/dsh-desktop/servers.json",
    logDirectory: "/home/alice/.local/state/dsh-desktop/logs",
  });

  const windows = resolveAppPaths(
    "windows",
    env({
      USERPROFILE: "C:\\Users\\Alice",
      APPDATA: "C:\\Users\\Alice\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local",
    }),
  );
  assert(windows.configFile.endsWith("dsh-desktop/servers.json"));
  assert(windows.logDirectory.endsWith("dsh-desktop/logs"));
  assert(windows.configFile.includes("AppData"));
  assert(windows.logDirectory.includes("Local"));
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
});

Deno.test("startSshTunnel supports fake child ready path and stop lifecycle", async () => {
  const logger = await memoryLogger();
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

  const logger = await memoryLogger();
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
  await logger.flush();
  const log = await Deno.readTextFile(logger.filePath);
  assertFalse(log.includes("secretbase64"));
  assert(log.includes("[REDACTED PRIVATE KEY MATERIAL]"));
});

Deno.test("JsonlLogger writes JSONL fields and errorContext", async () => {
  const directory = await Deno.makeTempDir();
  const logger = await JsonlLogger.create(directory, {
    sessionId: "session-1",
    now: () => new Date("2025-01-02T03:04:05.000Z"),
  });

  await logger.error("ssh.failed", "x".repeat(2100), {
    detail: "y".repeat(4100),
    token: "should-never-be-written",
    note: "password=hunter2 Authorization: Bearer abc123",
    ok: false,
  });
  await logger.flush();

  assertEquals(basename(logger.filePath), "dsh-desktop-2025-01-02.jsonl");
  const lines = (await Deno.readTextFile(logger.filePath)).trimEnd().split("\n");
  assertEquals(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assertEquals(entry.timestamp, "2025-01-02T03:04:05.000Z");
  assertEquals(entry.level, "error");
  assertEquals(entry.sessionId, "session-1");
  assertEquals(entry.event, "ssh.failed");
  assertEquals(entry.message.length, 2003);
  assertEquals(entry.context.detail.length, 4003);
  assertEquals(entry.context.token, "[REDACTED]");
  assertFalse(entry.context.note.includes("hunter2"));
  assertFalse(entry.context.note.includes("abc123"));
  assertEquals(entry.context.ok, false);

  const context = errorContext(new TypeError("boom"));
  assertEquals(context.errorName, "TypeError");
  assertEquals(context.errorMessage, "boom");
  assertExists(context.errorStack);
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
  return await JsonlLogger.create(directory, { sessionId: "test" });
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
