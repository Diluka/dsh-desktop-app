import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import {
  buildDshWebArguments,
  LocalDshError,
  localDshInstallError,
  type LocalDshLauncher,
  probeLocalDshLauncher,
  startLocalDshWeb,
} from "../src/local_dsh.ts";
import { fakeChild, memoryLogger, tempFile } from "./test_helpers.ts";

const DSH_LAUNCHER = {
  kind: "dsh",
  command: "fake-dsh",
  prefix: [],
} as const satisfies LocalDshLauncher;

const NPX_LAUNCHER = {
  kind: "npx",
  command: "fake-npx",
  prefix: ["-y", "@deepseek-ai/dsh"],
} as const satisfies LocalDshLauncher;

Deno.test("buildDshWebArguments starts loopback web without opening a browser", () => {
  assertEquals(buildDshWebArguments(45000), [
    "web",
    "--host",
    "127.0.0.1",
    "--port",
    "45000",
    "--no-open",
  ]);
});

Deno.test("probeLocalDshLauncher prefers dsh", async () => {
  const commands: string[] = [];
  const launcher = await probeLocalDshLauncher((command) => {
    commands.push(command);
    return Promise.resolve();
  }, "linux");

  assertEquals(commands, ["dsh"]);
  assertEquals(launcher, { kind: "dsh", command: "dsh", prefix: [] });
});

Deno.test("probeLocalDshLauncher preserves dsh on non-lookup errors", async () => {
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const launcher = await probeLocalDshLauncher(() => Promise.reject(denied), "linux");

  assertEquals(launcher, { kind: "dsh", command: "dsh", prefix: [] });
});

Deno.test("probeLocalDshLauncher falls back to npx", async () => {
  const commands: string[] = [];
  const launcher = await probeLocalDshLauncher((command) => {
    commands.push(command);
    return command === "dsh"
      ? Promise.reject(new Deno.errors.NotFound("missing dsh"))
      : Promise.resolve();
  }, "linux");

  assertEquals(commands, ["dsh", "npx"]);
  assertEquals(launcher, {
    kind: "npx",
    command: "npx",
    prefix: ["-y", "@deepseek-ai/dsh"],
  });
});

Deno.test("probeLocalDshLauncher reports no usable launcher", async () => {
  const launcher = await probeLocalDshLauncher(
    (command) => Promise.reject(new Deno.errors.NotFound(`missing ${command}`)),
    "linux",
  );
  const error = localDshInstallError();

  assertEquals(launcher, undefined);
  assertEquals(error.code, "DSH_NOT_FOUND");
  assertMatch(error.message, /dsh.*npx/u);
  assert(error.message.includes("PATH"));
});

Deno.test("startLocalDshWeb starts a resolved dsh launcher", async () => {
  const { logger } = await memoryLogger();
  const child = fakeChild();
  let capturedCommand = "";
  let capturedArgs: string[] = [];

  const web = await startLocalDshWeb(logger, DSH_LAUNCHER, {
    allocatePort: () => Promise.resolve(45000),
    spawn: (command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return child;
    },
    probe: (url) => {
      assertEquals(url, "http://127.0.0.1:45000/");
      return Promise.resolve();
    },
  });

  assertEquals(web.url, "http://127.0.0.1:45000/");
  assertEquals(capturedCommand, "fake-dsh");
  assertEquals(capturedArgs, buildDshWebArguments(45000));

  const stopped = web.stop();
  assertEquals(child.kills, ["SIGTERM"]);
  child.finish({ success: true, code: 0, signal: null });
  await stopped;
  assertEquals(await web.exited, {
    success: true,
    code: 0,
    signal: null,
    stopRequested: true,
  });
});

Deno.test("startLocalDshWeb prepends a resolved npx launcher", async () => {
  const { logger } = await memoryLogger();
  const child = fakeChild();
  let capturedCommand = "";
  let capturedArgs: string[] = [];

  const web = await startLocalDshWeb(logger, NPX_LAUNCHER, {
    allocatePort: () => Promise.resolve(45001),
    spawn: (command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return child;
    },
    probe: () => Promise.resolve(),
  });

  assertEquals(capturedCommand, "fake-npx");
  assertEquals(capturedArgs, ["-y", "@deepseek-ai/dsh", ...buildDshWebArguments(45001)]);
  const stopped = web.stop();
  child.finish({ success: true, code: 0, signal: null });
  await stopped;
});

Deno.test("startLocalDshWeb retries when a selected port is claimed", async () => {
  const { logger, filePath } = await memoryLogger();
  const busyOutput = await tempFile("busy.log");
  await Deno.writeTextFile(
    busyOutput,
    "warming up\nlisten EADDRINUSE: address already in use 127.0.0.1:45001\n",
  );
  const busy = fakeChild(busyOutput);
  const ready = fakeChild();
  const allocatedPorts: number[] = [];
  let spawnCount = 0;

  const web = await startLocalDshWeb(logger, DSH_LAUNCHER, {
    allocatePort: () => Promise.resolve(spawnCount === 0 ? 45001 : 45002),
    spawn: (_command, args) => {
      spawnCount += 1;
      allocatedPorts.push(Number(args[4]));
      if (spawnCount === 1) {
        busy.finish({ success: false, code: 1, signal: null });
        return busy;
      }
      return ready;
    },
    probe: () => spawnCount === 1 ? Promise.reject(new Error("not ready")) : Promise.resolve(),
    delay: () => Promise.resolve(),
  });

  assertEquals(web.url, "http://127.0.0.1:45002/");
  assertEquals(spawnCount, 2);
  assertEquals(allocatedPorts, [45001, 45002]);
  const stopped = web.stop();
  ready.finish({ success: true, code: 0, signal: null });
  await stopped;

  logger.flush();
  const log = await Deno.readTextFile(filePath);
  assert(!log.includes("EADDRINUSE"));
  assert(!log.includes("warming up"));
});

Deno.test("startLocalDshWeb cancels before spawning while port allocation is pending", async () => {
  const { logger } = await memoryLogger();
  const controller = new AbortController();
  let spawnCount = 0;
  const starting = startLocalDshWeb(logger, DSH_LAUNCHER, {
    allocatePort: () => new Promise<number>(() => {}),
    spawn: () => {
      spawnCount += 1;
      return fakeChild();
    },
    signal: controller.signal,
  });

  controller.abort();
  const error = await assertRejects(() => starting, LocalDshError);

  assertEquals(error.code, "START_CANCELLED");
  assertEquals(spawnCount, 0);
});

Deno.test("startLocalDshWeb cancels an in-progress npx launcher", async () => {
  const { logger } = await memoryLogger();
  const controller = new AbortController();
  const child = fakeChild();
  const originalKill = child.kill.bind(child);
  child.kill = (signal?: Deno.Signal) => {
    originalKill(signal);
    if (signal === "SIGTERM") child.finish({ success: false, code: 143, signal: "SIGTERM" });
  };
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const starting = startLocalDshWeb(logger, NPX_LAUNCHER, {
    allocatePort: () => Promise.resolve(45004),
    spawn: () => {
      resolveStarted();
      return child;
    },
    probe: () => new Promise<void>(() => {}),
    signal: controller.signal,
  });

  await started;
  controller.abort();
  const error = await assertRejects(() => starting, LocalDshError);

  assertEquals(error.code, "START_CANCELLED");
  assertEquals(child.kills, ["SIGTERM"]);
});
