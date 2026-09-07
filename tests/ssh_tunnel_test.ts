import { assert, assertEquals, assertFalse, assertMatch, assertRejects } from "@std/assert";
import { runHiddenCommand } from "../src/hidden_process.ts";
import {
  buildSshArguments,
  classifySshFailure,
  probeOpenSsh,
  startSshTunnel,
  TunnelError,
} from "../src/ssh_tunnel.ts";
import { fakeChild, memoryLogger, profile } from "./test_helpers.ts";

Deno.test("buildSshArguments creates exclusive foreground loopback forwarding without clearing forwards", () => {
  const args = buildSshArguments({ ...profile(), remotePort: 48080 }, 39001);
  for (
    const flag of [
      "-N",
      "-T",
      "BatchMode=yes",
      "ForkAfterAuthentication=no",
      "ControlMaster=no",
      "ControlPath=none",
      "ExitOnForwardFailure=yes",
      "ConnectTimeout=12",
      "ServerAliveInterval=30",
      "ServerAliveCountMax=3",
      "-L",
    ]
  ) assert(args.includes(flag), flag);
  assert(args.includes("127.0.0.1:39001:127.0.0.1:48080"));
  assertFalse(args.some((value) => /ClearAllForwardings|StrictHostKeyChecking/i.test(value)));
  assertEquals(args.slice(-2), ["--", "prod-dsh"]);
});

Deno.test("ssh -G confirms foreground and no multiplexing despite background/mux configuration", async () => {
  if (!(await probeOpenSsh()).available) return;
  const config = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(
      config,
      [
        "Host *",
        "  ForkAfterAuthentication yes",
        "  ControlMaster auto",
        "  ControlPath ~/.ssh/dsh-test-%h",
        "  ControlPersist yes",
      ].join("\n"),
    );
    // -G reads only our fixture; it never connects or changes user configuration.
    const result = await runHiddenCommand("ssh", [
      "-G",
      "-F",
      config,
      ...buildSshArguments(profile(), 39001),
    ]);
    assertEquals(result.success, true, result.stderr);
    assertMatch(result.stdout, /^forkafterauthentication no$/mu);
    assertMatch(result.stdout, /^controlmaster (false|no)$/mu);
    // OpenSSH omits ControlPath entirely for the special 'none' value.
    const controlPath = result.stdout.split("\n").find((line) => line.startsWith("controlpath "));
    assert(controlPath === undefined || controlPath === "controlpath none");
  } finally {
    await Deno.remove(config);
  }
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

Deno.test("startSshTunnel reports missing ssh at creation", async () => {
  const { logger } = await memoryLogger();
  const error = await assertRejects(() =>
    startSshTunnel(profile(), logger, {
      allocatePort: () => Promise.resolve(41000),
      spawn: () => {
        throw new Deno.errors.NotFound("missing ssh");
      },
      delay: () => {
        throw new Error("must not wait");
      },
    }), TunnelError);
  assertEquals(error.code, "SSH_NOT_FOUND");
});

Deno.test("startSshTunnel returns immediately after spawn with token-free process metadata", async () => {
  const { logger, filePath } = await memoryLogger();
  let capturedCommand = "";
  let capturedArgs: string[] = [];
  const child = fakeChild();
  const tunnel = await startSshTunnel({ ...profile(), dshWebToken: "private-token" }, logger, {
    command: "fake-ssh",
    allocatePort: () => Promise.resolve(41000),
    spawn: (command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return child;
    },
    delay: () => Promise.resolve(),
  });
  assertEquals(tunnel.url, "http://127.0.0.1:41000/");
  assertEquals(tunnel.localPort, 41000);
  assertEquals(capturedCommand, "fake-ssh");
  assertEquals(capturedArgs.at(-1), "prod-dsh");
  assertFalse(capturedArgs.join(" ").includes("private-token"));
  assertEquals(child.kills, []);
  logger.flush();
  assertFalse((await Deno.readTextFile(filePath)).includes("private-token"));
  const stopped = tunnel.stop();
  assertEquals(child.kills, ["SIGTERM"]);
  child.finish({ success: true, code: 0, signal: null });
  await stopped;
  assertEquals(await tunnel.exited, { success: true, code: 0, signal: null, stopRequested: true });
});

Deno.test("startSshTunnel returns even an immediately exited child for app supervision without retry", async () => {
  const { logger } = await memoryLogger();
  const child = fakeChild();
  child.finish({ success: false, code: 255, signal: null });
  let spawns = 0;
  const tunnel = await startSshTunnel(profile(), logger, {
    allocatePort: () => Promise.resolve(41001),
    spawn: () => {
      spawns++;
      return child;
    },
    delay: () => {
      throw new Error("must not wait for readiness");
    },
  });
  assertEquals(spawns, 1);
  assertEquals(child.kills, []);
  assertEquals(await tunnel.exited, {
    success: false,
    code: 255,
    signal: null,
    stopRequested: false,
  });
});

for (
  const [detail, code] of [
    ["Address already in use", "LOCAL_PORT_BUSY"],
    ["cannot listen to port", "LOCAL_PORT_BUSY"],
    ["could not request local forwarding", "LOCAL_PORT_BUSY"],
    ["ENOENT", "SSH_NOT_FOUND"],
    ["Permission denied (publickey).", "AUTH_FAILED"],
    ["Too many authentication failures", "AUTH_FAILED"],
    ["No more authentication methods", "AUTH_FAILED"],
    ["Host key verification failed.", "HOST_KEY_FAILED"],
    ["REMOTE HOST IDENTIFICATION HAS CHANGED", "HOST_KEY_FAILED"],
    ["Could not resolve hostname prod-dsh", "HOST_NOT_FOUND"],
    ["Connection refused", "CONNECTION_FAILED"],
    ["Operation timed out", "CONNECTION_FAILED"],
    ["No route to host", "CONNECTION_FAILED"],
    ["Timeout, server prod-dsh not responding.", "SSH_FAILED"],
    ["unknown exit", "SSH_FAILED"],
  ] as const
) {
  Deno.test(`classifySshFailure classifies exited process: ${detail}`, () => {
    const error = classifySshFailure(detail);
    assertEquals(error.code, code);
  });
}

Deno.test("classifySshFailure handles process launch errors without stderr", () => {
  assertEquals(classifySshFailure("", new Deno.errors.NotFound("missing")).code, "SSH_NOT_FOUND");
});

Deno.test("startSshTunnel cancels allocation and ignores the late result", async () => {
  const { logger } = await memoryLogger();
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const allocated = Promise.withResolvers<number>();
  let spawns = 0;
  const result = startSshTunnel(profile(), logger, {
    signal: controller.signal,
    allocatePort: () => {
      entered.resolve();
      return allocated.promise;
    },
    spawn: () => {
      spawns++;
      return fakeChild();
    },
  });
  const rejected = assertRejects(() => result, DOMException);
  await entered.promise;
  controller.abort(new Error("arbitrary reason"));
  assertEquals((await rejected).name, "AbortError");
  allocated.resolve(41000);
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(spawns, 0);
});

Deno.test("startSshTunnel rejects pre-cancellation before allocating or spawning", async () => {
  const { logger } = await memoryLogger();
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const error = await assertRejects(() =>
    startSshTunnel(profile(), logger, {
      signal: controller.signal,
      allocatePort: () => {
        calls++;
        return Promise.resolve(41000);
      },
      spawn: () => {
        calls++;
        return fakeChild();
      },
    }), DOMException);
  assertEquals(error.name, "AbortError");
  assertEquals(calls, 0);
});

Deno.test("startSshTunnel cancellation during spawn waits for created child cleanup", async () => {
  const { logger } = await memoryLogger();
  const controller = new AbortController();
  const killed = Promise.withResolvers<void>();
  const child = fakeChild();
  const kill = child.kill.bind(child);
  child.kill = (signal) => {
    kill(signal);
    killed.resolve();
  };
  let settled = false;
  const result = startSshTunnel(profile(), logger, {
    signal: controller.signal,
    allocatePort: () => Promise.resolve(41000),
    spawn: () => {
      controller.abort();
      return child;
    },
    delay: () => new Promise(() => {}),
  });
  const rejected = assertRejects(() => result, DOMException).then((error) => {
    settled = true;
    return error;
  });
  await killed.promise;
  await Promise.resolve();
  assertFalse(settled);
  assertEquals(child.kills, ["SIGTERM"]);
  child.finish({ success: false, code: 143, signal: "SIGTERM" });
  assertEquals((await rejected).name, "AbortError");
});

Deno.test("startSshTunnel cancellation cleans child even if shutdown delay fails", async () => {
  const { logger } = await memoryLogger();
  const controller = new AbortController();
  const child = fakeChild();
  const kill = child.kill.bind(child);
  child.kill = (signal) => {
    kill(signal);
    if (signal === "SIGKILL") child.finish({ success: false, code: 137, signal: "SIGKILL" });
  };
  const error = await assertRejects(() =>
    startSshTunnel(profile(), logger, {
      signal: controller.signal,
      allocatePort: () => Promise.resolve(41000),
      spawn: () => {
        controller.abort();
        return child;
      },
      delay: () => {
        throw new Error("shutdown delay failed");
      },
    }), DOMException);
  assertEquals(error.name, "AbortError");
  assertEquals(child.kills, ["SIGTERM", "SIGKILL"]);
});

Deno.test("startSshTunnel transfers lifetime ownership to app after creation", async () => {
  const { logger } = await memoryLogger();
  const controller = new AbortController();
  const child = fakeChild();
  const tunnel = await startSshTunnel(profile(), logger, {
    signal: controller.signal,
    allocatePort: () => Promise.resolve(41000),
    spawn: () => child,
    delay: () => Promise.resolve(),
  });
  controller.abort();
  assertEquals(child.kills, []);
  child.finish({ success: false, code: 255, signal: null });
  assertEquals((await tunnel.exited).stopRequested, false);
});
