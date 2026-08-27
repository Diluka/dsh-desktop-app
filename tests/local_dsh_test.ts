import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  buildDshWebArguments,
  LocalDshError,
  localDshInstallError,
  type LocalDshLauncher,
  probeLocalDshEnvironment,
  startLocalDshWeb,
} from "../src/local_dsh.ts";
import { resetWindowsPowershellDetection } from "../src/windows_powershell.ts";
import { fakeChild, memoryLogger, tempFile } from "./test_helpers.ts";

const DSH_LAUNCHER = {
  kind: "dsh",
  command: "fake-dsh",
  prefix: [],
} as const satisfies LocalDshLauncher;

const NPX_LAUNCHER = {
  kind: "npx",
  command: "/bin/bash",
  prefix: ["-lic", 'exec "$0" "$@"', "npx", "-y", "@deepseek-ai/dsh"],
} as const satisfies LocalDshLauncher;

const TOOL_PROBE_MARKER = "__DSH_DESKTOP_TOOL__";
const LOGIN_SHELL_EXEC = 'exec "$0" "$@"';

function versionOutput(version: string, success = true) {
  return { success, stdout: version, stderr: "" };
}

function windowsPs1Path(name: string) {
  return `C:\\tools\\npm\\${name}`;
}

// Windows probe mock: pwsh.exe (PowerShell 7) is detected, and the PowerShell
// Get-Command probe resolves .ps1 shims to an absolute path.
function windowsShimProbe() {
  return (command: string, args: string[]) => {
    if (command === "pwsh.exe" || command === "powershell.exe") {
      const script = args.at(-1) ?? "";
      if (script.includes("$PSVersionTable")) {
        return Promise.resolve(versionOutput("7.6.5"));
      }
      const name = /Get-Command ([a-z0-9._-]+)/iu.exec(script)?.[1];
      return Promise.resolve(versionOutput(name ? windowsPs1Path(name) : ""));
    }
    return Promise.resolve(versionOutput(command === "node" ? "v24.19.0" : "0.1.1-rc.2"));
  };
}

function loginShellOutput(values: Record<string, string>) {
  return versionOutput(
    Object.entries(values).map(([key, value]) => `${TOOL_PROBE_MARKER}${key}=${value}`).join("\n"),
  );
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

Deno.test("probeLocalDshEnvironment probes all Unix tools in one login shell", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const environment = await probeLocalDshEnvironment(
    (command, args) => {
      calls.push({ command, args });
      return Promise.resolve(loginShellOutput({
        "node.command": "/Users/alice/.mise/shims/node",
        "node.version": "v24.19.0",
        "dsh.command": "/Users/alice/.mise/shims/dsh",
        "dsh.version": "0.1.1-rc.2",
        "npx.command": "/Users/alice/.mise/shims/npx",
        "npx.version": "11.6.2",
      }));
    },
    "darwin",
    "/bin/zsh",
  );

  assertEquals(calls.length, 1);
  assertEquals(calls[0].command, "/bin/zsh");
  assertEquals(calls[0].args[0], "-lic");
  for (const tool of ["node", "dsh", "npx"]) {
    assertStringIncludes(calls[0].args[1], `${tool} --version`);
  }
  assert(!calls[0].args[1].includes("@deepseek-ai/dsh"));
  assertEquals(environment, {
    node: { command: "/Users/alice/.mise/shims/node", version: "v24.19.0" },
    dsh: { command: "/Users/alice/.mise/shims/dsh", version: "0.1.1-rc.2" },
    npx: { command: "/Users/alice/.mise/shims/npx", version: "11.6.2" },
    launcher: {
      kind: "dsh",
      command: "/bin/zsh",
      prefix: ["-lic", LOGIN_SHELL_EXEC, "dsh"],
    },
  });
});

Deno.test("probeLocalDshEnvironment selects a login-shell npx launcher when dsh is missing", async () => {
  const environment = await probeLocalDshEnvironment(
    () =>
      Promise.resolve(loginShellOutput({
        "npx.command": "/Users/alice/.nvm/current/bin/npx",
        "npx.version": "11.6.2",
      })),
    "darwin",
    "/bin/zsh",
  );

  assertEquals(environment.launcher, {
    kind: "npx",
    command: "/bin/zsh",
    prefix: ["-lic", LOGIN_SHELL_EXEC, "npx", "-y", "@deepseek-ai/dsh"],
  });
});

Deno.test("probeLocalDshEnvironment does not hide a broken login-shell dsh behind npx", async () => {
  const environment = await probeLocalDshEnvironment(
    () =>
      Promise.resolve(loginShellOutput({
        "node.command": "/tools/node",
        "node.version": "v24.19.0",
        "dsh.command": "/tools/dsh",
        "npx.command": "/tools/npx",
        "npx.version": "11.6.2",
      })),
    "linux",
    "/bin/bash",
  );

  assertEquals(environment.dsh, undefined);
  assertEquals(environment.launcher, undefined);
});

Deno.test("probeLocalDshEnvironment prefers Windows .ps1 shims", async () => {
  resetWindowsPowershellDetection();
  const environment = await probeLocalDshEnvironment(windowsShimProbe(), "windows");

  assertEquals(environment, {
    node: { command: "node", version: "v24.19.0" },
    dsh: { command: windowsPs1Path("dsh.ps1"), version: "0.1.1-rc.2" },
    npx: { command: windowsPs1Path("npx.ps1"), version: "0.1.1-rc.2" },
    powershell: { pwshAvailable: true, command: "pwsh.exe" },
    launcher: { kind: "dsh", command: windowsPs1Path("dsh.ps1"), prefix: [] },
  });
});

Deno.test("probeLocalDshEnvironment reports missing tools when .ps1 shims are absent", async () => {
  resetWindowsPowershellDetection();
  const environment = await probeLocalDshEnvironment(
    (command, args) => {
      if (command === "pwsh.exe" || command === "powershell.exe") {
        const script = args.at(-1) ?? "";
        if (script.includes("$PSVersionTable")) {
          return Promise.resolve(versionOutput("7.6.5"));
        }
        return Promise.resolve(versionOutput(""));
      }
      return Promise.resolve(versionOutput(command === "node" ? "v24.19.0" : "0.1.1-rc.2"));
    },
    "windows",
  );

  assertEquals(environment.node, { command: "node", version: "v24.19.0" });
  assertEquals(environment.dsh, undefined);
  assertEquals(environment.npx, undefined);
  assertEquals(environment.launcher, undefined);
});

Deno.test("probeLocalDshEnvironment falls back to npx when dsh is absent", async () => {
  resetWindowsPowershellDetection();
  const environment = await probeLocalDshEnvironment(
    (command, args) => {
      if (command === "pwsh.exe" || command === "powershell.exe") {
        const script = args.at(-1) ?? "";
        if (script.includes("$PSVersionTable")) {
          return Promise.resolve(versionOutput("7.6.5"));
        }
        const name = /Get-Command ([a-z0-9._-]+)/iu.exec(script)?.[1];
        if (name?.startsWith("dsh")) return Promise.resolve(versionOutput(""));
        return Promise.resolve(versionOutput(name ? windowsPs1Path(name) : ""));
      }
      return Promise.resolve(versionOutput(command === "node" ? "v24.19.0" : "11.6.2"));
    },
    "windows",
  );

  assertEquals(environment.launcher, {
    kind: "npx",
    command: windowsPs1Path("npx.ps1"),
    prefix: ["-y", "@deepseek-ai/dsh"],
  });
});

Deno.test("probeLocalDshEnvironment reports no usable launcher", async () => {
  const environment = await probeLocalDshEnvironment(
    () => Promise.resolve(versionOutput("")),
    "linux",
    "/bin/bash",
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

  assertEquals(capturedCommand, "/bin/bash");
  assertEquals(capturedArgs, [...NPX_LAUNCHER.prefix, ...buildDshWebArguments(45001)]);
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
