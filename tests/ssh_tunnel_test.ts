import { assert, assertEquals, assertFalse, assertMatch, assertRejects } from "@std/assert";
import { buildSshArguments, probeOpenSsh, startSshTunnel, TunnelError } from "../src/ssh_tunnel.ts";
import { fakeChild, memoryLogger, profile, tickingClock } from "./test_helpers.ts";

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

Deno.test("startSshTunnel reports missing ssh without entering readiness polling", async () => {
  const { logger } = await memoryLogger();
  const error = await assertRejects(
    () =>
      startSshTunnel(profile(), logger, {
        allocatePort: () => Promise.resolve(41000),
        spawn: () => {
          throw new Deno.errors.NotFound("missing ssh");
        },
        probe: () => {
          throw new Error("missing ssh should fail before probing");
        },
        delay: () => {
          throw new Error("missing ssh should fail before waiting");
        },
      }),
    TunnelError,
  );

  assertEquals(error.code, "SSH_NOT_FOUND");
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

Deno.test("startSshTunnel retries LOCAL_PORT_BUSY and succeeds on a later attempt", async () => {
  const { logger } = await memoryLogger();
  const busy = fakeChild("bind [127.0.0.1]:41001: Address already in use\n");
  const ready = fakeChild();
  const allocatedPorts: number[] = [];
  let spawnCount = 0;

  const tunnel = await startSshTunnel(profile(), logger, {
    allocatePort: () => Promise.resolve(spawnCount === 0 ? 41001 : 41002),
    spawn: (_command, args) => {
      spawnCount += 1;
      const forwardIndex = args.indexOf("-L") + 1;
      allocatedPorts.push(Number(args[forwardIndex].split(":")[1]));
      if (spawnCount === 1) {
        busy.finish({ success: false, code: 255, signal: null });
        return busy;
      }
      return ready;
    },
    probe: () => spawnCount === 1 ? Promise.reject(new Error("not ready")) : Promise.resolve(),
    delay: () => Promise.resolve(),
    now: tickingClock(0, 1000),
    startupTimeoutMs: 5000,
  });

  assertEquals(tunnel.url, "http://127.0.0.1:41002/");
  assertEquals(spawnCount, 2);
  assertEquals(allocatedPorts, [41001, 41002]);
  const stopped = tunnel.stop();
  ready.finish({ success: true, code: 0, signal: null });
  await stopped;
});

Deno.test("startSshTunnel throws LOCAL_PORT_BUSY after repeated local port conflicts", async () => {
  const { logger } = await memoryLogger();
  let attempts = 0;

  const error = await assertRejects(
    () =>
      startSshTunnel(profile(), logger, {
        allocatePort: () => Promise.resolve(41001 + attempts),
        spawn: () => {
          attempts += 1;
          const child = fakeChild("channel_setup_fwd_listener_tcpip: cannot listen to port\n");
          child.finish({ success: false, code: 255, signal: null });
          return child;
        },
        probe: () => Promise.reject(new Error("not ready")),
        delay: () => Promise.resolve(),
        now: tickingClock(0, 1000),
        startupTimeoutMs: 5000,
      }),
    TunnelError,
  );

  assertEquals(error.code, "LOCAL_PORT_BUSY");
  assertEquals(attempts, 3);
});

Deno.test("startSshTunnel stops tunnel and throws DSH_UNAVAILABLE when remote probe times out", async () => {
  const { logger } = await memoryLogger();
  const child = fakeChild();
  const originalKill = child.kill.bind(child);
  child.kill = (signal?: Deno.Signal) => {
    originalKill(signal);
    if (signal === "SIGKILL") child.finish({ success: false, code: 137, signal: "SIGKILL" });
  };

  const error = await assertRejects(
    () =>
      startSshTunnel(profile(), logger, {
        allocatePort: () => Promise.resolve(41003),
        spawn: () => child,
        probe: () => Promise.reject(new Error("not ready")),
        delay: () => Promise.resolve(),
        now: tickingClock(0, 1000),
        startupTimeoutMs: 3000,
      }),
    TunnelError,
  );

  assertEquals(error.code, "DSH_UNAVAILABLE");
  assertEquals(child.kills, ["SIGTERM", "SIGKILL"]);
  await child.status;
});

Deno.test("startSshTunnel classifies auth failures", async () => {
  const { logger } = await memoryLogger();
  const error = await startAndClassify("Permission denied (publickey).\n", logger);
  assertEquals(error.code, "AUTH_FAILED");
});

Deno.test("startSshTunnel classifies host key verification failures", async () => {
  const { logger } = await memoryLogger();
  const error = await startAndClassify("Host key verification failed.\n", logger);
  assertEquals(error.code, "HOST_KEY_FAILED");
});

Deno.test("startSshTunnel classifies missing hosts", async () => {
  const { logger } = await memoryLogger();
  const error = await startAndClassify("Could not resolve hostname prod-dsh\n", logger);
  assertEquals(error.code, "HOST_NOT_FOUND");
});

Deno.test("startSshTunnel classifies SSH connection failures", async () => {
  const { logger } = await memoryLogger();
  const error = await startAndClassify(
    "ssh: connect to host prod-dsh port 22: Connection refused\n",
    logger,
  );
  assertEquals(error.code, "CONNECTION_FAILED");
});

async function startAndClassify(
  stderr: string,
  logger: Awaited<ReturnType<typeof memoryLogger>>["logger"],
) {
  const child = fakeChild(stderr);
  child.finish({ success: false, code: 255, signal: null });

  return await assertRejects(
    () =>
      startSshTunnel(profile(), logger, {
        allocatePort: () => Promise.resolve(41005),
        spawn: () => child,
        probe: () => Promise.reject(new Error("not ready")),
        delay: () => Promise.resolve(),
        now: tickingClock(0, 1000),
        startupTimeoutMs: 5000,
      }),
    TunnelError,
  );
}
