import { assert, assertEquals, assertRejects } from "@std/assert";
import { startDesktop, waitForSshReconnect } from "../app.ts";
import { SshTunnel } from "../src/ssh_tunnel.ts";
import { fakeChild, profile } from "./test_helpers.ts";

Deno.test("startDesktop cleans up the shell server when home environment is missing", async () => {
  const originalHome = Deno.env.get("HOME");
  const originalUserProfile = Deno.env.get("USERPROFILE");
  Deno.env.delete("HOME");
  Deno.env.delete("USERPROFILE");
  try {
    await assertRejects(
      () => startDesktop("cef"),
      Error,
      "Cannot locate the current user's home directory",
    );
  } finally {
    restoreEnvironment("HOME", originalHome);
    restoreEnvironment("USERPROFILE", originalUserProfile);
  }
});

Deno.test("SSH recovery waits for each actual exit and ignores superseded observers", async () => {
  for (let crash = 0; crash < 2; crash++) {
    const child = fakeChild();
    const tunnel = new SshTunnel(profile(), 41000, child, () => Promise.resolve());
    const old = new AbortController();
    const superseded = waitForSshReconnect(tunnel, old.signal);
    old.abort(); // A manual token retry reuses this child with a new observer.
    let eligible = false;
    const recovery = waitForSshReconnect(tunnel, new AbortController().signal).then((value) => {
      eligible = value;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(eligible, false);
    const exitedAt = Date.now();
    child.finish({ success: false, code: 255, signal: null });
    assertEquals(await superseded, false);
    assertEquals(await recovery, true);
    assert(Date.now() - exitedAt >= 900, "recovery must retain the fixed short delay");
  }
});

Deno.test("intentional SSH stop never becomes eligible for recovery", async () => {
  const child = fakeChild();
  const tunnel = new SshTunnel(profile(), 41000, child, () => Promise.resolve());
  const recovery = waitForSshReconnect(tunnel, new AbortController().signal);
  child.kill = () => child.finish({ success: false, code: 143, signal: "SIGTERM" });
  await tunnel.stop();
  assertEquals(await recovery, false);
});

Deno.test("manual switch or shutdown cancels a pending SSH recovery delay", async () => {
  const child = fakeChild();
  const tunnel = new SshTunnel(profile(), 41000, child, () => Promise.resolve());
  const controller = new AbortController();
  const recovery = waitForSshReconnect(tunnel, controller.signal);
  child.finish({ success: false, code: 255, signal: null });
  await tunnel.exited;
  controller.abort();
  assertEquals(await recovery, false);
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    Deno.env.delete(name);
  } else {
    Deno.env.set(name, value);
  }
}
