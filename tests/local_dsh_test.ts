import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { buildDshWebArguments, LocalDshError, startLocalDshWeb } from "../src/local_dsh.ts";
import { fakeChild, memoryLogger, tickingClock } from "./test_helpers.ts";

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
    now: () => 1000,
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

Deno.test("startLocalDshWeb retries when a selected port is claimed", async () => {
  const { logger, filePath } = await memoryLogger();
  const busy = fakeChild("warming up\nlisten EADDRINUSE: address already in use 127.0.0.1:45001\n");
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
    now: tickingClock(0, 1000),
    startupTimeoutMs: 5000,
  });

  assertEquals(web.url, "http://127.0.0.1:45002/");
  assertEquals(spawnCount, 2);
  assertEquals(allocatedPorts, [45001, 45002]);
  const stopped = web.stop();
  ready.finish({ success: true, code: 0, signal: null });
  await stopped;

  logger.flush();
  const log = await Deno.readTextFile(filePath);
  assert(log.includes("EADDRINUSE"));
  assert(!log.includes("warming up"));
});

Deno.test("startLocalDshWeb reports missing dsh command", async () => {
  const { logger } = await memoryLogger();
  const error = await assertRejects(
    () =>
      startLocalDshWeb(logger, {
        allocatePort: () => Promise.resolve(45003),
        spawn: () => {
          throw new Deno.errors.NotFound("missing dsh");
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

  assertEquals(error.code, "DSH_NOT_FOUND");
  assertMatch(error.message, /dsh/u);
  assert(error.message.includes("PATH"));
});
