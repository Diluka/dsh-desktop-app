import { assert, assertEquals, assertFalse, assertMatch, assertRejects } from "@std/assert";
import { buildSshArguments, probeOpenSsh, startSshTunnel, TunnelError } from "../src/ssh_tunnel.ts";
import { fakeChild, memoryLogger, profile, tempFile, tickingClock } from "./test_helpers.ts";

Deno.test("buildSshArguments creates non-interactive loopback forwarding without clearing forwards", () => {
  const args = buildSshArguments({
    id: "p1",
    name: "Production",
    sshTarget: "prod-dsh",
    remotePort: 48080,
    dshWebToken: "",
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
      assertEquals(url, "http://127.0.0.1:41000/?token=");
      return Promise.resolve(200);
    },
    now: () => 1000,
  });

  assertEquals(tunnel.url, "http://127.0.0.1:41000/?token=");
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
    stopRequested: true,
  });
});

Deno.test("startSshTunnel probes and exposes the saved DSH Web token URL", async () => {
  const { logger } = await memoryLogger();
  let capturedArgs: string[] = [];
  const child = fakeChild();

  const tunnel = await startSshTunnel({ ...profile(), dshWebToken: "manual-token" }, logger, {
    command: "fake-ssh",
    allocatePort: () => Promise.resolve(41006),
    spawn: (_command, args) => {
      capturedArgs = args;
      return child;
    },
    probe: (url) => {
      assertEquals(url, "http://127.0.0.1:41006/?token=manual-token");
      return Promise.resolve(200);
    },
    now: () => 1000,
  });

  assertEquals(tunnel.url, "http://127.0.0.1:41006/?token=manual-token");
  assertFalse(capturedArgs.includes("manual-token"));

  const stopped = tunnel.stop();
  child.finish({ success: true, code: 0, signal: null });
  await stopped;
});

Deno.test("startSshTunnel asks for a new token when remote DSH Web returns 401", async () => {
  const { logger } = await memoryLogger();
  const child = fakeChild();
  const originalKill = child.kill.bind(child);
  child.kill = (signal?: Deno.Signal) => {
    originalKill(signal);
    if (signal === "SIGTERM") child.finish({ success: false, code: 143, signal: "SIGTERM" });
  };

  const error = await assertRejects(
    () =>
      startSshTunnel(profile(), logger, {
        command: "fake-ssh",
        allocatePort: () => Promise.resolve(41007),
        spawn: () => child,
        probe: (url) => {
          assertEquals(url, "http://127.0.0.1:41007/?token=");
          return Promise.resolve(401);
        },
        delay: () => Promise.resolve(),
        now: () => 1000,
      }),
    TunnelError,
  );

  assertEquals(error.code, "DSH_LOGIN_REQUIRED");
  assertEquals(child.kills, ["SIGTERM"]);
  await child.status;
});

Deno.test("startSshTunnel keeps the tunnel when a recovered token verifies", async () => {
  const { logger } = await memoryLogger();
  const child = fakeChild();
  let recoveredContext:
    | { localPort: number; currentUrl: string }
    | undefined;

  const tunnel = await startSshTunnel(profile(), logger, {
    command: "fake-ssh",
    allocatePort: () => Promise.resolve(41008),
    spawn: () => child,
    probe: (url) => {
      assertEquals(url, "http://127.0.0.1:41008/?token=");
      return Promise.resolve(401);
    },
    recoverToken: ({ localPort, currentUrl }) => {
      recoveredContext = { localPort, currentUrl };
      return Promise.resolve({ token: "auto-token", sourceId: "tmux" });
    },
    delay: () => Promise.resolve(),
    now: () => 1000,
  });

  assertEquals(recoveredContext, {
    localPort: 41008,
    currentUrl: "http://127.0.0.1:41008/?token=",
  });
  assertEquals(tunnel.url, "http://127.0.0.1:41008/?token=auto-token");
  assertEquals(child.kills, []);

  const stopped = tunnel.stop();
  child.finish({ success: true, code: 0, signal: null });
  await stopped;
});

Deno.test("startSshTunnel retries LOCAL_PORT_BUSY and succeeds on a later attempt", async () => {
  const { logger } = await memoryLogger();
  const busyOutput = await tempFile("busy.log");
  await Deno.writeTextFile(busyOutput, "bind [127.0.0.1]:41001: Address already in use\n");
  const busy = fakeChild(busyOutput);
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
    probe: () => spawnCount === 1 ? Promise.reject(new Error("not ready")) : Promise.resolve(200),
    delay: () => Promise.resolve(),
    now: tickingClock(0, 1000),
    startupTimeoutMs: 5000,
  });

  assertEquals(tunnel.url, "http://127.0.0.1:41002/?token=");
  assertEquals(spawnCount, 2);
  assertEquals(allocatedPorts, [41001, 41002]);
  const stopped = tunnel.stop();
  ready.finish({ success: true, code: 0, signal: null });
  await stopped;
});

Deno.test("startSshTunnel throws LOCAL_PORT_BUSY after repeated local port conflicts", async () => {
  const { logger } = await memoryLogger();
  const busyOutput = await tempFile("busy.log");
  await Deno.writeTextFile(
    busyOutput,
    "channel_setup_fwd_listener_tcpip: cannot listen to port\n",
  );
  let attempts = 0;

  const error = await assertRejects(
    () =>
      startSshTunnel(profile(), logger, {
        allocatePort: () => Promise.resolve(41001 + attempts),
        spawn: () => {
          attempts += 1;
          const child = fakeChild(busyOutput);
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

Deno.test("startSshTunnel keeps child output out of the app log", async () => {
  const { logger, filePath } = await memoryLogger();
  const error = await startAndClassify(
    "debug: connecting\nPermission denied (publickey).\n",
    logger,
  );
  assertEquals(error.code, "AUTH_FAILED");

  logger.flush();
  const log = await Deno.readTextFile(filePath);
  assertFalse(log.includes("Permission denied"));
  assertFalse(log.includes("debug: connecting"));
});

for (
  const { name, stderr, code } of [
    {
      name: "host key verification failures",
      stderr: "Host key verification failed.\n",
      code: "HOST_KEY_FAILED",
    },
    {
      name: "missing hosts",
      stderr: "Could not resolve hostname prod-dsh\n",
      code: "HOST_NOT_FOUND",
    },
    {
      name: "SSH connection failures",
      stderr: "ssh: connect to host prod-dsh port 22: Connection refused\n",
      code: "CONNECTION_FAILED",
    },
  ] as const
) {
  Deno.test(`startSshTunnel classifies ${name}`, async () => {
    const { logger } = await memoryLogger();
    const error = await startAndClassify(stderr, logger);
    assertEquals(error.code, code);
  });
}

for (const stage of ["allocate", "probe", "delay", "recoverToken"] as const) {
  Deno.test(`startSshTunnel cancels while waiting for ${stage} and ignores late results`, async () => {
    const { logger } = await memoryLogger();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<void>();
    const child = fakeChild();
    const kill = child.kill.bind(child);
    child.kill = (signal) => {
      kill(signal);
      child.finish({ success: false, code: 143, signal: "SIGTERM" });
    };
    let spawns = 0;
    let recoveries = 0;
    const pause = () => {
      entered.resolve();
      return blocked.promise;
    };
    const result = startSshTunnel(profile(), logger, {
      signal: controller.signal,
      allocatePort: async () => {
        if (stage === "allocate") await pause();
        return 41009;
      },
      spawn: () => {
        spawns++;
        return child;
      },
      probe: async () => {
        if (stage === "probe") await pause();
        return stage === "recoverToken" ? 401 : stage === "delay" ? 503 : 200;
      },
      delay: (ms) => stage === "delay" && ms === 150 ? pause() : Promise.resolve(),
      recoverToken: async () => {
        recoveries++;
        await pause();
        return { token: "late-token" };
      },
      now: () => 1000,
    });
    let settled = false;
    const rejected = assertRejects(() => result, DOMException).then((error) => {
      settled = true;
      return error;
    });
    await entered.promise;
    controller.abort(new Error("arbitrary abort reason"));
    if (stage === "recoverToken") {
      // Recovery can own another SSH process, so cancellation awaits its cleanup.
      await Promise.resolve();
      assertFalse(settled);
      blocked.resolve();
    }
    assertEquals((await rejected).name, "AbortError");
    assertEquals(spawns, stage === "allocate" ? 0 : 1);
    assertEquals(child.kills, stage === "allocate" ? [] : ["SIGTERM"]);
    blocked.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(spawns, stage === "allocate" ? 0 : 1);
    assertEquals(recoveries, stage === "recoverToken" ? 1 : 0);
  });
}

Deno.test("startSshTunnel rejects already cancelled signals without allocating or spawning", async () => {
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

Deno.test("startSshTunnel cancellation waits for child cleanup before rejecting", async () => {
  const { logger } = await memoryLogger();
  const controller = new AbortController();
  const probing = Promise.withResolvers<void>();
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
    spawn: () => child,
    probe: () => {
      probing.resolve();
      return new Promise(() => {});
    },
    delay: () => new Promise(() => {}),
  });
  const rejected = assertRejects(() => result, DOMException).then((error) => {
    settled = true;
    return error;
  });
  await probing.promise;
  controller.abort();
  await killed.promise;
  await Promise.resolve();
  assertFalse(settled);
  assertEquals(child.kills, ["SIGTERM"]);
  child.finish({ success: false, code: 143, signal: "SIGTERM" });
  assertEquals((await rejected).name, "AbortError");
});

for (const stage of ["spawn", "probe", "recoverToken"] as const) {
  Deno.test(`startSshTunnel cancellation wins simultaneous ${stage} success`, async () => {
    const { logger } = await memoryLogger();
    const controller = new AbortController();
    const child = fakeChild();
    const kill = child.kill.bind(child);
    child.kill = (signal) => {
      kill(signal);
      child.finish({ success: false, code: 143, signal: "SIGTERM" });
    };
    let probes = 0;
    const error = await assertRejects(() =>
      startSshTunnel(profile(), logger, {
        signal: controller.signal,
        allocatePort: () => Promise.resolve(41000),
        spawn: () => {
          if (stage === "spawn") controller.abort();
          return child;
        },
        probe: () => {
          probes++;
          if (stage === "probe") controller.abort();
          return Promise.resolve(stage === "recoverToken" ? 401 : 200);
        },
        recoverToken: () => {
          controller.abort();
          return Promise.resolve({ token: "too-late" });
        },
        delay: () => Promise.resolve(),
      }), DOMException);
    assertEquals(error.name, "AbortError");
    assertEquals(child.kills, ["SIGTERM"]);
    assertEquals(probes, stage === "spawn" ? 0 : 1);
  });
}

for (const stage of ["probe", "delay", "clock"] as const) {
  Deno.test(`startSshTunnel cleans child on unexpected ${stage} exception`, async () => {
    const { logger } = await memoryLogger();
    const child = fakeChild();
    const kill = child.kill.bind(child);
    child.kill = (signal) => {
      kill(signal);
      if (signal === "SIGKILL") child.finish({ success: false, code: 137, signal: "SIGKILL" });
    };
    const failure = new Error("unexpected startup failure");
    const error = await assertRejects(() =>
      startSshTunnel(profile(), logger, {
        allocatePort: () => Promise.resolve(41000),
        spawn: () => child,
        probe: () => {
          if (stage === "probe") throw failure;
          return Promise.resolve(503);
        },
        delay: () => {
          if (stage === "delay") throw failure;
          return Promise.resolve();
        },
        now: () => {
          if (stage === "clock") throw failure;
          return 1000;
        },
      })
    );
    assertEquals(error, failure);
    assertEquals(child.kills, ["SIGTERM", "SIGKILL"]);
  });
}

Deno.test("startSshTunnel keeps recovery errors and token URLs out of logs", async () => {
  const { logger, filePath } = await memoryLogger();
  const child = fakeChild();
  child.kill = () => child.finish({ success: false, code: 143, signal: "SIGTERM" });
  const error = await assertRejects(
    () =>
      startSshTunnel({ ...profile(), dshWebToken: "private-token" }, logger, {
        allocatePort: () => Promise.resolve(41000),
        spawn: () => child,
        probe: () => Promise.resolve(401),
        recoverToken: () => Promise.reject(new Error("http://127.0.0.1/?token=private-token")),
        delay: () => Promise.resolve(),
      }),
    TunnelError,
  );
  assertEquals(error.code, "DSH_LOGIN_REQUIRED");
  logger.flush();
  const log = await Deno.readTextFile(filePath);
  assertFalse(log.includes("private-token"));
  assertFalse(log.includes("http://"));
});

Deno.test("startSshTunnel removes startup abort listeners on success", async () => {
  const { logger } = await memoryLogger();
  const controller = new AbortController();
  let listeners = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args: Parameters<AbortSignal["addEventListener"]>) => {
    const [type, listener, options] = args;
    if (type === "abort") listeners++;
    add(type, listener, options);
  };
  controller.signal.removeEventListener = (
    ...args: Parameters<AbortSignal["removeEventListener"]>
  ) => {
    const [type, listener, options] = args;
    if (type === "abort") listeners--;
    remove(type, listener, options);
  };
  const child = fakeChild();
  const tunnel = await startSshTunnel(profile(), logger, {
    signal: controller.signal,
    allocatePort: () => Promise.resolve(41000),
    spawn: () => child,
    probe: () => Promise.resolve(200),
    delay: () => Promise.resolve(),
  });
  assertEquals(listeners, 0);
  controller.abort();
  assertEquals(child.kills, []);
  const stopped = tunnel.stop();
  child.finish({ success: true, code: 0, signal: null });
  await stopped;
});

async function startAndClassify(
  stderr: string,
  logger: Awaited<ReturnType<typeof memoryLogger>>["logger"],
) {
  const outputFile = await tempFile("ssh.log");
  await Deno.writeTextFile(outputFile, stderr);
  const child = fakeChild(outputFile);
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
