import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import {
  buildDshWebArguments,
  buildNpxDshWebArguments,
  LocalDshError,
  startLocalDshWeb,
} from "../src/local_dsh.ts";
import { fakeChild, memoryLogger, tempFile } from "./test_helpers.ts";

Deno.test("buildDshWebArguments starts loopback web without opening a browser", () => {
  const args = buildDshWebArguments(45000);

  assertEquals(args, ["web", "--host", "127.0.0.1", "--port", "45000", "--no-open"]);
});

Deno.test("startLocalDshWeb supports fake child ready path and stop lifecycle", async () => {
  const { logger } = await memoryLogger();
  let capturedCommand = "";
  let capturedArgs: string[] = [];
  const child = fakeChild();

  const web = await startLocalDshWeb(logger, {
    command: "fake-dsh",
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

Deno.test("startLocalDshWeb falls back to npx when dsh is missing", async () => {
  const { logger } = await memoryLogger();
  const child = fakeChild();
  const commands: string[] = [];
  let npxArgs: string[] = [];

  const web = await startLocalDshWeb(logger, {
    allocatePort: () => Promise.resolve(45001),
    spawn: (command, args) => {
      commands.push(command);
      if (command === "dsh") throw new Deno.errors.NotFound("missing dsh");
      npxArgs = args;
      return child;
    },
    probe: () => Promise.resolve(),
  });

  assertEquals(commands[0], "dsh");
  if (Deno.build.os === "windows") {
    assertMatch(commands[1], /cmd(?:\.exe)?$/iu);
    assertEquals(npxArgs.slice(0, 4), ["/d", "/s", "/c", "npx.cmd"]);
    assertEquals(npxArgs.slice(4), buildNpxDshWebArguments(45001));
  } else {
    assertEquals(commands[1], "npx");
    assertEquals(npxArgs, buildNpxDshWebArguments(45001));
  }
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

  const web = await startLocalDshWeb(logger, {
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

Deno.test("startLocalDshWeb reports installation help after dsh and npx fail", async () => {
  const { logger } = await memoryLogger();
  const commands: string[] = [];
  const error = await assertRejects(
    () =>
      startLocalDshWeb(logger, {
        allocatePort: () => Promise.resolve(45003),
        spawn: (command) => {
          commands.push(command);
          throw new Deno.errors.NotFound(`missing ${command}`);
        },
        probe: () => {
          throw new Error("missing dsh should fail before probing");
        },
        delay: () => {
          throw new Error("missing dsh should fail before waiting");
        },
      }),
    LocalDshError,
  );

  assertEquals(commands[0], "dsh");
  assertEquals(commands.length, 2);
  assertEquals(error.code, "DSH_NOT_FOUND");
  assertMatch(error.message, /dsh.*npx/u);
  assert(error.message.includes("PATH"));
});

Deno.test("startLocalDshWeb cancels before spawning while port allocation is pending", async () => {
  const { logger } = await memoryLogger();
  const controller = new AbortController();
  let spawnCount = 0;
  const starting = startLocalDshWeb(logger, {
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

Deno.test("startLocalDshWeb cancels an in-progress npx fallback", async () => {
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
  const commands: string[] = [];
  const starting = startLocalDshWeb(logger, {
    allocatePort: () => Promise.resolve(45004),
    spawn: (command) => {
      commands.push(command);
      if (command === "dsh") throw new Deno.errors.NotFound("missing dsh");
      resolveStarted();
      return child;
    },
    probe: () => new Promise<void>(() => {}),
    signal: controller.signal,
  });

  await started;
  controller.abort();
  const error = await assertRejects(() => starting, LocalDshError);

  assertEquals(commands[0], "dsh");
  assertEquals(commands.length, 2);
  assertEquals(error.code, "START_CANCELLED");
  assertEquals(child.kills, ["SIGTERM"]);
});
