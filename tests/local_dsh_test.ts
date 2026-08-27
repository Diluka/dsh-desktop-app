import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import {
  buildDshWebArguments,
  LocalDshError,
  localDshInstallError,
  type LocalDshLauncher,
  probeLocalDshEnvironment,
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

const NO_PATH_RESOLUTION = () => Promise.resolve({});
const RESOLVE_NODE = () => Promise.resolve({ node: "node" });

function versionOutput(version: string, success = true) {
  return { success, stdout: version, stderr: "" };
}

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

Deno.test("probeLocalDshEnvironment probes tool versions without running the DSH package", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const versions: Record<string, string> = {
    node: "v24.19.0",
    dsh: "0.1.1-rc.2",
    npx: "11.6.2",
  };
  const environment = await probeLocalDshEnvironment(
    (command, args) => {
      calls.push({ command, args });
      return Promise.resolve(versionOutput(versions[command]));
    },
    "linux",
    () => Promise.resolve({ node: "node", dsh: "/shell/dsh", npx: "/shell/npx" }),
  );

  assertEquals(calls.length, 3);
  for (const command of ["node", "dsh", "npx"]) {
    assertEquals(calls.find((call) => call.command === command)?.args, ["--version"]);
  }
  assert(calls.every((call) => !call.args.includes("@deepseek-ai/dsh")));
  assertEquals(environment, {
    node: { command: "node", version: "v24.19.0" },
    dsh: { command: "dsh", version: "0.1.1-rc.2" },
    npx: { command: "npx", version: "11.6.2" },
    launcher: { kind: "dsh", command: "dsh", prefix: [] },
  });
});

Deno.test("probeLocalDshEnvironment selects npx only when dsh is missing", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const environment = await probeLocalDshEnvironment(
    (command, args) => {
      calls.push({ command, args });
      if (command === "dsh") return Promise.reject(new Deno.errors.NotFound("missing dsh"));
      return Promise.resolve(versionOutput(command === "node" ? "v24.19.0" : "11.6.2"));
    },
    "linux",
    RESOLVE_NODE,
  );

  assertEquals(calls.find((call) => call.command === "npx")?.args, ["--version"]);
  assertEquals(environment.launcher, {
    kind: "npx",
    command: "npx",
    prefix: ["-y", "@deepseek-ai/dsh"],
  });
});

Deno.test("probeLocalDshEnvironment does not hide a broken dsh behind npx", async () => {
  const calls: string[] = [];
  const environment = await probeLocalDshEnvironment(
    (command) => {
      calls.push(command);
      if (command === "dsh") return Promise.resolve(versionOutput("", false));
      return Promise.resolve(versionOutput(command === "node" ? "v24.19.0" : "11.6.2"));
    },
    "linux",
    () => Promise.resolve({ node: "node", dsh: "/shell/dsh", npx: "/shell/npx" }),
  );

  assert(!calls.includes("/shell/dsh"));
  assertEquals(environment.dsh, undefined);
  assertEquals(environment.launcher, undefined);
});

Deno.test("probeLocalDshEnvironment resolves all login-shell paths once", async () => {
  const probedCommands: string[] = [];
  const resolvedCommandSets: string[][] = [];
  const environment = await probeLocalDshEnvironment(
    (command) => {
      probedCommands.push(command);
      if (!command.startsWith("/Users/alice/tools/bin/")) {
        return Promise.reject(new Deno.errors.NotFound(`missing ${command}`));
      }
      const name = command.split("/").at(-1);
      const version = name === "node" ? "v24.19.0" : name === "dsh" ? "0.1.1" : "11.6.2";
      return Promise.resolve(versionOutput(version));
    },
    "darwin",
    (commands) => {
      resolvedCommandSets.push(commands);
      return Promise.resolve(Object.fromEntries(
        commands.map((command) => [command, `/Users/alice/tools/bin/${command}`]),
      ));
    },
  );

  assertEquals(resolvedCommandSets, [["node", "dsh", "npx"]]);
  assertEquals(probedCommands, [
    "dsh",
    "npx",
    "/Users/alice/tools/bin/node",
    "/Users/alice/tools/bin/dsh",
    "/Users/alice/tools/bin/npx",
  ]);
  assertEquals(environment.node?.command, "/Users/alice/tools/bin/node");
  assertEquals(environment.dsh?.command, "/Users/alice/tools/bin/dsh");
  assertEquals(environment.npx?.command, "/Users/alice/tools/bin/npx");
  assertEquals(environment.launcher?.kind, "dsh");
});

Deno.test("probeLocalDshEnvironment reports no usable launcher", async () => {
  const environment = await probeLocalDshEnvironment(
    (command) => Promise.reject(new Deno.errors.NotFound(`missing ${command}`)),
    "linux",
    NO_PATH_RESOLUTION,
  );
  const error = localDshInstallError();

  assertEquals(environment, {
    node: undefined,
    dsh: undefined,
    npx: undefined,
    launcher: undefined,
  });
  assertEquals(error.code, "DSH_NOT_FOUND");
  assertMatch(error.message, /dsh.*npx/u);
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

Deno.test("startLocalDshWeb adds the DSH package only for an actual npx launch", async () => {
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

Deno.test("startLocalDshWeb cancels an in-progress npx launch", async () => {
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
