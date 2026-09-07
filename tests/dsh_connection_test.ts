import { kill as signalProcess } from "node:process";
import { assert, assertEquals, assertFalse, assertRejects, assertStrictEquals } from "@std/assert";
import { connectDshWeb, DshConnectionError } from "../src/dsh_connection.ts";
import { runHiddenCommand } from "../src/hidden_process.ts";
import { recoverRemoteDshWebToken } from "../src/remote_dsh_token_probe.ts";
import { startSshTunnel, TunnelError } from "../src/ssh_tunnel.ts";
import { fakeChild, memoryLogger, profile, tickingClock } from "./test_helpers.ts";

const recovered = {
  token: "auto-token",
  url: "http://127.0.0.1:3080/?token=auto-token",
  sourceId: "tmux",
};

for (const status of [200, 204, 302]) {
  Deno.test(`connectDshWeb returns saved token URL on HTTP ${status}`, async () => {
    const result = await connectDshWeb({ ...profile(), dshWebToken: "saved + token" }, 41000, {
      signal: new AbortController().signal,
      probe: (url) => {
        assertEquals(url, "http://127.0.0.1:41000/?token=saved+%2B+token");
        return Promise.resolve(status);
      },
      recoverToken: () => {
        throw new Error("must not recover");
      },
    });
    assertEquals(result, { url: "http://127.0.0.1:41000/?token=saved+%2B+token" });
  });
}

Deno.test("connectDshWeb returns verified recovered token without persisting or mutating profile", async () => {
  const remoteProfile = { ...profile(), dshWebToken: "stale" };
  let recoveries = 0;
  const result = await connectDshWeb(remoteProfile, 41000, {
    signal: new AbortController().signal,
    probe: () => Promise.resolve(401),
    recoverToken: () => {
      recoveries++;
      return Promise.resolve(recovered);
    },
  });
  assertEquals(result.url, "http://127.0.0.1:41000/?token=auto-token");
  assertStrictEquals(result.recovered, recovered);
  assertEquals(remoteProfile.dshWebToken, "stale");
  assertEquals(recoveries, 1);
});

for (const recoveryFails of [false, true]) {
  Deno.test(`connectDshWeb attempts recovery once and reports independent login error (${recoveryFails})`, async () => {
    let recoveries = 0;
    let probes = 0;
    const error = await assertRejects(() =>
      connectDshWeb(profile(), 41000, {
        signal: new AbortController().signal,
        probe: () => {
          probes++;
          return Promise.resolve(401);
        },
        recoverToken: () => {
          recoveries++;
          if (recoveryFails) throw new Error("http://private/?token=secret");
          return Promise.resolve(undefined);
        },
      }), DshConnectionError);
    assertEquals(error.code, "DSH_LOGIN_REQUIRED");
    assertFalse(error instanceof TunnelError);
    assertFalse(error.message.includes("secret"));
    assertEquals(probes, 1);
    assertEquals(recoveries, 1);
  });
}

for (const status of [0, 403, 404, 500, 503]) {
  Deno.test(`connectDshWeb bounds unavailable service ${status} and never invokes token recovery`, async () => {
    let probes = 0;
    const error = await assertRejects(() =>
      connectDshWeb(profile(), 41000, {
        signal: new AbortController().signal,
        probe: () => {
          probes++;
          if (status === 0) throw new Error("connection refused: http://private/?token=secret");
          return Promise.resolve(status);
        },
        now: tickingClock(0, 1000),
        delay: () => Promise.resolve(),
        recoverToken: () => {
          throw new Error("must not recover");
        },
      }), DshConnectionError);
    assertEquals(probes, 19);
    assertEquals(error.code, "DSH_UNAVAILABLE");
    assertFalse(error instanceof TunnelError);
    assertFalse(error.message.includes("secret"));
  });
}

Deno.test("connectDshWeb retries transient service failure within the deadline", async () => {
  let probes = 0;
  const delays: number[] = [];
  const result = await connectDshWeb(profile(), 41000, {
    signal: new AbortController().signal,
    probe: () => Promise.resolve(++probes < 3 ? 503 : 200),
    delay: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  });
  assertEquals(result.url, "http://127.0.0.1:41000/?token=");
  assertEquals(delays, [150, 150]);
});

Deno.test("connectDshWeb enforces timeout even when an injected HTTP probe never resolves", async () => {
  const error = await assertRejects(() =>
    connectDshWeb(profile(), 41000, {
      signal: new AbortController().signal,
      startupTimeoutMs: 10,
      probe: () => new Promise(() => {}),
    }), DshConnectionError);
  assertEquals(error.code, "DSH_UNAVAILABLE");
});

Deno.test("connectDshWeb pre-cancellation starts no HTTP or recovery work", async () => {
  const controller = new AbortController();
  controller.abort(new Error("custom reason"));
  let calls = 0;
  const error = await assertRejects(() =>
    connectDshWeb(profile(), 41000, {
      signal: controller.signal,
      probe: () => {
        calls++;
        return Promise.resolve(200);
      },
      recoverToken: () => {
        calls++;
        return Promise.resolve(recovered);
      },
    }), DOMException);
  assertEquals(error.name, "AbortError");
  assertEquals(calls, 0);
});

for (const stage of ["probe", "delay", "recoverToken"] as const) {
  Deno.test(`connectDshWeb cancels during ${stage} and ignores late success`, async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<void>();
    const pause = () => {
      entered.resolve();
      return blocked.promise;
    };
    let recoveries = 0;
    const result = connectDshWeb(profile(), 41000, {
      signal: controller.signal,
      probe: async () => {
        if (stage === "probe") await pause();
        return stage === "recoverToken" ? 401 : stage === "delay" ? 503 : 200;
      },
      delay: () => pause(),
      recoverToken: async () => {
        recoveries++;
        await pause();
        return recovered;
      },
    });
    let settled = false;
    const rejected = assertRejects(() => result, DOMException).then((error) => {
      settled = true;
      return error;
    });
    await entered.promise;
    controller.abort(new Error("custom reason"));
    if (stage === "recoverToken") {
      await Promise.resolve();
      assertFalse(settled, "must await auxiliary recovery cleanup");
      blocked.resolve();
    }
    assertEquals((await rejected).name, "AbortError");
    blocked.resolve();
    await Promise.resolve();
    assertEquals(recoveries, stage === "recoverToken" ? 1 : 0);
  });
}

for (const stage of ["probe", "recoverToken"] as const) {
  Deno.test(`connectDshWeb cancellation wins simultaneous ${stage} success`, async () => {
    const controller = new AbortController();
    const error = await assertRejects(() =>
      connectDshWeb(profile(), 41000, {
        signal: controller.signal,
        probe: () => {
          if (stage === "probe") controller.abort();
          return Promise.resolve(stage === "probe" ? 200 : 401);
        },
        recoverToken: () => {
          controller.abort();
          return Promise.resolve(recovered);
        },
      }), DOMException);
    assertEquals(error.name, "AbortError");
  });
}

Deno.test("DSH failure, cancellation, token update and retry leave the main process unchanged", async () => {
  const { logger } = await memoryLogger();
  const child = fakeChild();
  let spawns = 0;
  const tunnel = await startSshTunnel(profile(), logger, {
    allocatePort: () => Promise.resolve(41000),
    spawn: () => {
      spawns++;
      return child;
    },
  });
  // The main exit observer is independent of all DSH outcomes.
  let observedExit = false;
  const observation = tunnel.exited.then(() => {
    observedExit = true;
  });
  for (const status of [401, 503, 0]) {
    const error = await assertRejects(() =>
      connectDshWeb(profile(), tunnel.localPort, {
        signal: new AbortController().signal,
        probe: () => status === 0 ? Promise.reject(new Error("offline")) : Promise.resolve(status),
        recoverToken: () => Promise.resolve(undefined),
        now: tickingClock(0, 1000),
        delay: () => Promise.resolve(),
        startupTimeoutMs: 3000,
      }), DshConnectionError);
    assertEquals(error.code, status === 401 ? "DSH_LOGIN_REQUIRED" : "DSH_UNAVAILABLE");
    assertEquals(child.kills, []);
    assertEquals(spawns, 1);
    assertFalse(observedExit);
  }
  const controller = new AbortController();
  const check = connectDshWeb(profile(), tunnel.localPort, {
    signal: controller.signal,
    probe: () => new Promise(() => {}),
  });
  const aborted = assertRejects(() => check, DOMException);
  controller.abort();
  assertEquals((await aborted).name, "AbortError");
  const retry = await connectDshWeb({ ...profile(), dshWebToken: "manual-new" }, tunnel.localPort, {
    signal: new AbortController().signal,
    probe: () => Promise.resolve(200),
  });
  assertEquals(retry.url, "http://127.0.0.1:41000/?token=manual-new");
  assertEquals(tunnel.url, "http://127.0.0.1:41000/");
  assertEquals(spawns, 1);
  assertEquals(child.kills, []);
  child.finish({ success: false, code: 255, signal: null });
  await observation;
  assert(observedExit);
  assertEquals((await tunnel.exited).stopRequested, false);
});

Deno.test("connectDshWeb default HTTP probe uses saved token and does not follow redirects", async () => {
  let seenUrl = "";
  let seenAccept = "";
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (request) => {
    seenUrl = request.url;
    seenAccept = request.headers.get("accept") ?? "";
    return new Response(null, { status: 302, headers: { location: "/should-not-follow" } });
  });
  try {
    const result = await connectDshWeb(
      { ...profile(), dshWebToken: "saved-token" },
      server.addr.port,
      {
        signal: new AbortController().signal,
      },
    );
    assertEquals(seenUrl, result.url);
    assertEquals(new URL(seenUrl).searchParams.get("token"), "saved-token");
    assertEquals(seenAccept, "text/html");
  } finally {
    await server.shutdown();
  }
});

Deno.test("connectDshWeb cancellation aborts an active default HTTP request", async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async () => {
    entered.resolve();
    await release.promise;
    return new Response("late");
  });
  const result = connectDshWeb(profile(), server.addr.port, { signal: controller.signal });
  try {
    const rejected = assertRejects(() => result, DOMException);
    await entered.promise;
    controller.abort();
    assertEquals((await rejected).name, "AbortError");
  } finally {
    controller.abort();
    release.resolve();
    await result.catch(() => undefined);
    await server.shutdown();
  }
});

Deno.test("DSH cancellation waits for the real auxiliary recovery process, not killing main SSH", async () => {
  const { logger } = await memoryLogger();
  const controller = new AbortController();
  const started = Promise.withResolvers<number>();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      started.resolve(Number(await request.text()));
      return new Response("ready");
    },
  );
  const child = fakeChild();
  const tunnel = await startSshTunnel(profile(), logger, {
    allocatePort: () => Promise.resolve(41000),
    spawn: () => child,
  });
  let candidateProbes = 0;
  let recoveryFinished = false;
  const result = connectDshWeb(profile(), tunnel.localPort, {
    signal: controller.signal,
    probe: () => Promise.resolve(401),
    recoverToken: async () => {
      try {
        return await recoverRemoteDshWebToken(profile(), tunnel.localPort, {
          signal: controller.signal,
          command: Deno.execPath(),
          timeoutMilliseconds: 5_000,
          programs: [{
            id: "real-process",
            args: () => [
              "eval",
              `
              await fetch("http://127.0.0.1:${server.addr.port}", { method: "POST", body: String(Deno.pid) });
              setInterval(() => {}, 1000);
            `,
            ],
          }],
          probe: () => {
            candidateProbes++;
            return Promise.resolve(200);
          },
        });
      } finally {
        recoveryFinished = true;
      }
    },
  });
  try {
    const pid = await Promise.race([
      started.promise,
      result.then(() => {
        throw new Error("DSH completed before recovery started");
      }),
    ]);
    const rejected = assertRejects(() => result, DOMException);
    controller.abort();
    assertEquals((await rejected).name, "AbortError");
    assertEquals(recoveryFinished, true);
    assertEquals(candidateProbes, 0);
    assertEquals(child.kills, []);
    if (Deno.build.os === "windows") {
      const running = await runHiddenCommand("tasklist", ["/fi", `PID eq ${pid}`, "/nh"]);
      assertFalse(running.stdout.includes(String(pid)));
    } else {
      let alive = false;
      try {
        signalProcess(pid, 0);
        alive = true;
      } catch { /* process exited */ }
      assertFalse(alive, "DSH cancellation left the auxiliary process running");
    }
  } finally {
    controller.abort();
    await result.catch(() => undefined);
    child.finish({ success: true, code: 0, signal: null });
    await tunnel.exited;
    await server.shutdown();
  }
});
