import { assertEquals, assertFalse, assertRejects, assertStrictEquals } from "@std/assert";
import { reconnectSshTunnel, type SshReconnectProgress } from "../src/ssh_reconnect.ts";
import { SshTunnel, startSshTunnel, TunnelError, type TunnelErrorCode } from "../src/ssh_tunnel.ts";
import { fakeChild, memoryLogger, profile, tempFile } from "./test_helpers.ts";

function readyTunnel() {
  const child = fakeChild();
  const kill = child.kill.bind(child);
  child.kill = (signal) => {
    kill(signal);
    child.finish({ success: false, code: 143, signal: "SIGTERM" });
  };
  return {
    child,
    tunnel: new SshTunnel("http://127.0.0.1:41000/?token=secret", child, () => Promise.resolve()),
  };
}

Deno.test("reconnectSshTunnel stops after OpenSSH reports too many authentication failures", async () => {
  const { logger } = await memoryLogger();
  const outputFile = await tempFile("ssh-auth.log");
  await Deno.writeTextFile(
    outputFile,
    "Received disconnect from 127.0.0.1 port 22:2: Too many authentication failures\n",
  );
  let attempts = 0;
  const error = await assertRejects(() =>
    reconnectSshTunnel(profile(), logger, {
      signal: new AbortController().signal,
      onProgress: () => {},
      delay: () => Promise.resolve(),
      start: (signal) => {
        attempts++;
        const child = fakeChild(outputFile);
        child.finish({ success: false, code: 255, signal: null });
        return startSshTunnel(profile(), logger, {
          signal,
          allocatePort: () => Promise.resolve(41000),
          spawn: () => child,
          probe: () => new Promise(() => {}),
          delay: () => Promise.resolve(),
        });
      },
    }), TunnelError);
  assertEquals(error.code, "AUTH_FAILED");
  assertEquals(attempts, 1);
});

Deno.test("reconnectSshTunnel reports ordered backoff phases and succeeds", async () => {
  const { logger } = await memoryLogger();
  const { child, tunnel } = readyTunnel();
  const controller = new AbortController();
  const events: unknown[] = [];
  let attempts = 0;
  const result = await reconnectSshTunnel(profile(), logger, {
    signal: controller.signal,
    onProgress: (progress) => events.push(progress),
    delay: (ms, signal) => {
      assertStrictEquals(signal, controller.signal);
      events.push(["delay", ms]);
      return Promise.resolve();
    },
    start: (signal) => {
      assertStrictEquals(signal, controller.signal);
      events.push(["start", ++attempts]);
      if (attempts < 3) return Promise.reject(new TunnelError("CONNECTION_FAILED", "offline"));
      return Promise.resolve(tunnel);
    },
  });
  assertStrictEquals(result, tunnel);
  assertEquals(
    events,
    [1000, 2000, 4000].flatMap((delayMs, index) => [
      { phase: "waiting", attempt: index + 1, maxAttempts: 5, delayMs },
      ["delay", delayMs],
      { phase: "connecting", attempt: index + 1, maxAttempts: 5, delayMs },
      ["start", index + 1],
    ]),
  );
  assertEquals(child.kills, []);
  await tunnel.stop();
});

Deno.test("reconnectSshTunnel exhausts exactly five attempts and retains the last error", async () => {
  const { logger, filePath } = await memoryLogger();
  const delays: number[] = [];
  const errors = [
    "CONNECTION_FAILED",
    "HOST_NOT_FOUND",
    "LOCAL_PORT_BUSY",
    "SSH_FAILED",
    "DSH_UNAVAILABLE",
  ]
    .map((code) => new TunnelError(code as TunnelErrorCode, "http://secret/?token=private-token"));
  let attempts = 0;
  const error = await assertRejects(
    () =>
      reconnectSshTunnel({ ...profile(), dshWebToken: "private-token" }, logger, {
        signal: new AbortController().signal,
        onProgress: () => {},
        delay: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
        start: () => Promise.reject(errors[attempts++]),
      }),
    TunnelError,
  );
  assertStrictEquals(error, errors[4]);
  assertEquals(attempts, 5);
  assertEquals(delays, [1000, 2000, 4000, 8000, 15000]);
  logger.flush();
  const log = await Deno.readTextFile(filePath);
  assertFalse(log.includes("private-token"));
  assertFalse(log.includes("http://"));
  const failures = log.split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.event === "ssh.reconnect_failed");
  assertEquals(failures.map((entry) => entry.attempt), [1, 2, 3, 4, 5]);
  assertEquals(failures.map((entry) => entry.errorCode), errors.map((error) => error.code));
});

for (
  const failure of [
    ...(["AUTH_FAILED", "HOST_KEY_FAILED", "SSH_NOT_FOUND", "DSH_LOGIN_REQUIRED"] as const)
      .map((code) => new TunnelError(code, "terminal")),
    new Error("unknown"),
  ]
) {
  Deno.test(`reconnectSshTunnel stops on ${failure instanceof TunnelError ? failure.code : "unknown error"}`, async () => {
    const { logger } = await memoryLogger();
    let attempts = 0;
    let waits = 0;
    const error = await assertRejects(() =>
      reconnectSshTunnel(profile(), logger, {
        signal: new AbortController().signal,
        onProgress: () => {},
        delay: () => {
          waits++;
          return Promise.resolve();
        },
        start: () => {
          attempts++;
          return Promise.reject(failure);
        },
      })
    );
    assertStrictEquals(error, failure);
    assertEquals(attempts, 1);
    assertEquals(waits, 1);
  });
}

Deno.test("reconnectSshTunnel does no work for an already cancelled signal", async () => {
  const { logger } = await memoryLogger();
  const controller = new AbortController();
  controller.abort(new Error("not an AbortError"));
  let calls = 0;
  const error = await assertRejects(() =>
    reconnectSshTunnel(profile(), logger, {
      signal: controller.signal,
      onProgress: () => {
        calls++;
      },
      delay: () => {
        calls++;
        return Promise.resolve();
      },
      start: () => {
        calls++;
        throw new Error("must not start");
      },
    }), DOMException);
  assertEquals(error.name, "AbortError");
  assertEquals(calls, 0);
});

Deno.test("reconnectSshTunnel cancels an uncooperative delay without starting", async () => {
  const { logger } = await memoryLogger();
  const controller = new AbortController();
  const waiting = Promise.withResolvers<void>();
  const delayed = Promise.withResolvers<void>();
  const progress: SshReconnectProgress[] = [];
  let attempts = 0;
  const result = reconnectSshTunnel(profile(), logger, {
    signal: controller.signal,
    onProgress: (value) => progress.push(value),
    delay: () => {
      waiting.resolve();
      return delayed.promise;
    },
    start: () => {
      attempts++;
      throw new Error("must not start");
    },
  });
  const rejected = assertRejects(() => result, DOMException);
  await waiting.promise;
  controller.abort();
  assertEquals((await rejected).name, "AbortError");
  delayed.resolve();
  await Promise.resolve();
  assertEquals(attempts, 0);
  assertEquals(progress.map((value) => value.phase), ["waiting"]);
});

Deno.test("reconnectSshTunnel cancels its default timer", async () => {
  const { logger } = await memoryLogger();
  const controller = new AbortController();
  const result = reconnectSshTunnel(profile(), logger, {
    signal: controller.signal,
    onProgress: () => {},
    start: () => {
      throw new Error("must not start");
    },
  });
  const rejected = assertRejects(() => result, DOMException);
  // Let the default delay install its timer before cancelling it.
  await Promise.resolve();
  controller.abort();
  assertEquals((await rejected).name, "AbortError");
});

Deno.test("reconnectSshTunnel cancels pending startup and disposes a late tunnel", async () => {
  const { logger } = await memoryLogger();
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const late = Promise.withResolvers<SshTunnel>();
  const { child, tunnel } = readyTunnel();
  let attempts = 0;
  const result = reconnectSshTunnel(profile(), logger, {
    signal: controller.signal,
    onProgress: () => {},
    delay: () => Promise.resolve(),
    start: () => {
      attempts++;
      started.resolve();
      return late.promise;
    },
  });
  let settled = false;
  const rejected = assertRejects(() => result, DOMException).then((error) => {
    settled = true;
    return error;
  });
  await started.promise;
  controller.abort();
  await Promise.resolve();
  assertFalse(settled);
  assertEquals(child.kills, []);
  late.resolve(tunnel);
  assertEquals((await rejected).name, "AbortError");
  await tunnel.exited;
  assertEquals(child.kills, ["SIGTERM"]);
  assertEquals(attempts, 1);
});

Deno.test("reconnectSshTunnel prefers cancellation to a simultaneous startup result", async () => {
  const { logger } = await memoryLogger();
  const controller = new AbortController();
  const { child, tunnel } = readyTunnel();
  const error = await assertRejects(() =>
    reconnectSshTunnel(profile(), logger, {
      signal: controller.signal,
      onProgress: () => {},
      delay: () => Promise.resolve(),
      start: () => {
        controller.abort();
        return Promise.resolve(tunnel);
      },
    }), DOMException);
  assertEquals(error.name, "AbortError");
  await tunnel.exited;
  assertEquals(child.kills, ["SIGTERM"]);
});

Deno.test("reconnectSshTunnel prefers cancellation to terminal failure and never retries", async () => {
  const { logger } = await memoryLogger();
  const controller = new AbortController();
  let attempts = 0;
  const error = await assertRejects(() =>
    reconnectSshTunnel(profile(), logger, {
      signal: controller.signal,
      onProgress: () => {},
      delay: () => Promise.resolve(),
      start: () => {
        attempts++;
        controller.abort();
        throw new TunnelError("AUTH_FAILED", "cancel wins");
      },
    }), DOMException);
  assertEquals(error.name, "AbortError");
  assertEquals(attempts, 1);
});

Deno.test("reconnectSshTunnel removes abort listeners after success and failure", async () => {
  const { logger } = await memoryLogger();
  const { tunnel } = readyTunnel();
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
  let attempts = 0;
  await reconnectSshTunnel(profile(), logger, {
    signal: controller.signal,
    onProgress: () => assertEquals(listeners, 0),
    delay: () => Promise.resolve(),
    start: () =>
      ++attempts < 2
        ? Promise.reject(new TunnelError("SSH_FAILED", "retry"))
        : Promise.resolve(tunnel),
  });
  assertEquals(listeners, 0);
  await tunnel.stop();
});
