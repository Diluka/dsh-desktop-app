import { assertEquals, assertFalse, assertRejects } from "@std/assert";
import { connectRemoteDsh } from "../src/remote_connection.ts";
import { type SshTunnel, startSshTunnel, TunnelError } from "../src/ssh_tunnel.ts";
import { fakeChild, memoryLogger, profile } from "./test_helpers.ts";

Deno.test("SSH startup returns ownership without waiting for DSH HTTP", async () => {
  const { logger } = await memoryLogger();
  const child = fakeChild();
  const tunnel = await startSshTunnel(profile(), logger, {
    allocatePort: () => Promise.resolve(41000),
    spawn: () => child,
    delay: () => Promise.resolve(),
  });
  assertEquals(tunnel.matches(profile()), true);
  assertEquals(child.kills, []);
  child.finish({ success: true, code: 0, signal: null });
  await tunnel.exited;
  assertFalse(tunnel.matches(profile()));
});

for (const recovery of ["none", "missing", "throws"] as const) {
  Deno.test(`login failure (${recovery}) registers and retains SSH for edited-token retry`, async () => {
    const { logger } = await memoryLogger();
    const child = fakeChild();
    let active: SshTunnel | undefined;
    let spawns = 0;
    let registrations = 0;
    const options = {
      allocatePort: () => Promise.resolve(41000),
      spawn: () => {
        spawns++;
        return child;
      },
      onTunnel: (tunnel: SshTunnel) => {
        active = tunnel;
        registrations++;
      },
      delay: () => Promise.resolve(),
    };
    const error = await assertRejects(() =>
      connectRemoteDsh(profile(), logger, {
        ...options,
        probe: () => {
          assertEquals(active?.url, "http://127.0.0.1:41000/?token=");
          return Promise.resolve(401);
        },
        recoverToken: recovery === "none"
          ? undefined
          : () =>
            recovery === "missing"
              ? Promise.resolve(undefined)
              : Promise.reject(new Error("token lookup failed")),
      }), TunnelError);
    assertEquals(error.code, "DSH_LOGIN_REQUIRED");
    assertEquals(child.kills, []);
    const retried = await connectRemoteDsh({ ...profile(), dshWebToken: "edited" }, logger, {
      ...options,
      tunnel: active,
      probe: (url) => {
        assertEquals(url, "http://127.0.0.1:41000/?token=edited");
        return Promise.resolve(200);
      },
    });
    assertEquals(retried, active);
    assertEquals(spawns, 1);
    assertEquals(registrations, 1);
    assertEquals(child.kills, []);
    const stopped = retried.stop();
    child.finish({ success: true, code: 0, signal: null });
    await stopped;
    assertEquals(child.kills, ["SIGTERM"]);
    assertFalse(retried.matches(profile()));
  });
}

for (
  const change of [
    { id: "other" },
    { sshTarget: "other-host" },
    { remotePort: 8080 },
    "exited",
  ] as const
) {
  Deno.test(`remote retry replaces SSH for ${JSON.stringify(change)}`, async () => {
    const { logger } = await memoryLogger();
    const old = fakeChild();
    const next = fakeChild();
    const tunnel = await startSshTunnel(profile(), logger, {
      allocatePort: () => Promise.resolve(41000),
      spawn: () => old,
      delay: () => Promise.resolve(),
    });
    old.kill = (signal) => {
      old.kills.push(signal);
      old.finish({ success: false, code: 143, signal: "SIGTERM" });
    };
    if (change === "exited") {
      old.finish({ success: false, code: 255, signal: null });
      await tunnel.exited;
    }
    const connected = await connectRemoteDsh(
      { ...profile(), ...(change === "exited" ? {} : change) },
      logger,
      {
        tunnel,
        allocatePort: () => Promise.resolve(41001),
        spawn: () => next,
        onTunnel: () => {},
        probe: () => Promise.resolve(200),
      },
    );
    assertEquals(old.kills, change === "exited" ? [] : ["SIGTERM"]);
    assertEquals(connected.localPort, 41001);
    next.finish({ success: true, code: 0, signal: null });
    await connected.exited;
  });
}

Deno.test("shutdown during port allocation stops the late child without registering it", async () => {
  const { logger } = await memoryLogger();
  const controller = new AbortController();
  const child = fakeChild();
  child.kill = (signal) => {
    child.kills.push(signal);
    child.finish({ success: true, code: 0, signal: null });
  };
  await assertRejects(
    () =>
      connectRemoteDsh(profile(), logger, {
        signal: controller.signal,
        allocatePort: () => {
          controller.abort();
          return Promise.resolve(41000);
        },
        spawn: () => child,
        delay: () => Promise.resolve(),
        onTunnel: () => {
          throw new Error("must not register a late child");
        },
      }),
    DOMException,
    "aborted",
  );
  assertEquals(child.kills, ["SIGTERM"]);
});

for (const outcome of ["shutdown", "exit"] as const) {
  Deno.test(`late recovered token cannot complete connection after ${outcome}`, async () => {
    const { logger } = await memoryLogger();
    const controller = new AbortController();
    const child = fakeChild();
    let active!: SshTunnel;
    await assertRejects(() =>
      connectRemoteDsh(profile(), logger, {
        signal: controller.signal,
        allocatePort: () => Promise.resolve(41000),
        spawn: () => child,
        onTunnel: (tunnel) => {
          active = tunnel;
        },
        delay: () => Promise.resolve(),
        probe: () => Promise.resolve(401),
        recoverToken: async () => {
          if (outcome === "shutdown") controller.abort();
          child.finish({ success: false, code: 255, signal: null });
          await active.exited;
          return { token: "late" };
        },
      })
    );
    assertFalse(active.matches(profile()));
  });
}
