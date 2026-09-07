import { join } from "node:path";
import { kill as signalProcess } from "node:process";
import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  isCommandNotFoundError,
  readProcessOutputTail,
  runHiddenCommand,
  spawnHiddenProcess,
} from "../src/hidden_process.ts";

Deno.test("spawnHiddenProcess redirects output to a dedicated file", async () => {
  const directory = await Deno.makeTempDir();
  const child = spawnHiddenProcess(
    Deno.execPath(),
    ["eval", 'console.log("stdout line"); console.error("stderr line");'],
    directory,
  );

  assertEquals(await child.status, { success: true, code: 0, signal: null });
  assert(child.outputFile.startsWith(directory));
  assert(child.outputFile.endsWith(".log"));
  if (Deno.build.os !== "windows") {
    const mode = (await Deno.stat(child.outputFile)).mode ?? 0;
    assertEquals(mode & 0o777, 0o600);
  }
  const output = await Deno.readTextFile(child.outputFile);
  assertStringIncludes(output, "stdout line");
  assertStringIncludes(output, "stderr line");
  assertStringIncludes(await readProcessOutputTail(child.outputFile), "stderr line");
});

Deno.test("spawnHiddenProcess runs Windows .ps1 shims through PowerShell", async () => {
  if (Deno.build.os !== "windows") return;
  const directory = await Deno.makeTempDir();
  const script = join(directory, "fixture.ps1");
  await Deno.writeTextFile(script, "Write-Output 'ps1 output'\n");

  const child = spawnHiddenProcess(script, [], directory);

  assertEquals(await child.status, { success: true, code: 0, signal: null });
  assertStringIncludes(await Deno.readTextFile(child.outputFile), "ps1 output");
  const probe = await runHiddenCommand(script, []);
  assertEquals(probe.success, true);
  assertStringIncludes(probe.stdout, "ps1 output");
});

Deno.test("runHiddenCommand enforces an optional timeout", async () => {
  const started = performance.now();
  const output = await runHiddenCommand(
    Deno.execPath(),
    ["eval", "setInterval(() => {}, 1_000)"],
    50,
  );

  assertFalse(output.success);
  assertEquals(output.signal, "SIGKILL");
  assert(performance.now() - started < 5_000);
});

Deno.test("runHiddenCommand can write stdin", async () => {
  const output = await runHiddenCommand(Deno.execPath(), [
    "eval",
    "const input = await new Response(Deno.stdin.readable).text(); console.log(input.toUpperCase())",
  ], { stdin: "probe script" });

  assertEquals(output.success, true);
  assertStringIncludes(output.stdout, "PROBE SCRIPT");
});

Deno.test("readProcessOutputTail starts at a complete UTF-8 character", async () => {
  const filePath = await Deno.makeTempFile();
  const suffix = "\nPermission denied";
  const targetBytes = 16 * 1024 + 1;
  const fixedBytes = new TextEncoder().encode(`é${suffix}`).length;
  await Deno.writeTextFile(filePath, `é${"x".repeat(targetBytes - fixedBytes)}${suffix}`);

  const tail = await readProcessOutputTail(filePath);
  assertFalse(tail.includes("�"));
  assertStringIncludes(tail, "Permission denied");
});

Deno.test("spawnHiddenProcess reports command lookup failures without parsing output", async () => {
  const directory = await Deno.makeTempDir();
  const child = spawnHiddenProcess(`missing-${crypto.randomUUID()}`, [], directory);
  const status = await child.status;

  assertEquals(status.success, false);
  assertEquals(status.code, 127);
  assert(isCommandNotFoundError(status.error));
});

Deno.test("spawnHiddenProcess kill stops a running child", async () => {
  const directory = await Deno.makeTempDir();
  const child = spawnHiddenProcess(
    Deno.execPath(),
    ["eval", "setInterval(() => {}, 1_000)"],
    directory,
  );

  child.kill("SIGTERM");

  assertEquals((await child.status).success, false);
});

Deno.test("spawnHiddenProcess kill terminates the process tree on Windows", async () => {
  if (Deno.build.os !== "windows") return;
  const directory = await Deno.makeTempDir();
  // A .ps1 shim runs a child synchronously, so the spawned child is PowerShell and
  // its descendant process must not survive kill.
  const script = join(directory, "long-running.ps1");
  const denoPath = Deno.execPath().replaceAll("\\", "/").replaceAll("'", "''");
  await Deno.writeTextFile(
    script,
    [
      `& '${denoPath}' eval "console.log('DESCENDANT_PID=' + Deno.pid); setInterval(() => {}, 1000)"`,
    ].join("\n"),
  );

  const child = spawnHiddenProcess(script, [], directory);
  let childPid = 0;
  for (let i = 0; i < 200 && childPid === 0; i++) {
    const output = await readProcessOutputTail(child.outputFile);
    childPid = Number(/DESCENDANT_PID=(\d+)/u.exec(output)?.[1] ?? 0);
    if (childPid === 0) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (childPid === 0) {
    const detail = await readProcessOutputTail(child.outputFile);
    child.kill("SIGTERM");
    assert(false, `the descendant process did not start: ${detail}`);
  }

  child.kill("SIGTERM");
  assertEquals((await child.status).success, false);

  let alive = await processExists(childPid);
  for (let i = 0; i < 40 && alive; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    alive = await processExists(childPid);
  }
  assertFalse(alive, "the descendant process is still running");
});

Deno.test("runHiddenCommand pre-cancellation does not spawn", async () => {
  const controller = new AbortController();
  controller.abort(new Error("custom cancellation reason"));
  const error = await assertRejects(() =>
    runHiddenCommand(`missing-${crypto.randomUUID()}`, [], {
      signal: controller.signal,
    }), DOMException);
  assertEquals(error.name, "AbortError");
});

Deno.test("runHiddenCommand cancellation waits until its real child has exited", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<number>();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      started.resolve(Number(await request.text()));
      return new Response("ready");
    },
  );
  const url = `http://127.0.0.1:${server.addr.port}`;
  const result = runHiddenCommand(Deno.execPath(), [
    "eval",
    `
    await fetch(${JSON.stringify(url)}, { method: "POST", body: String(Deno.pid) });
    setInterval(() => {}, 1000);
  `,
  ], { signal: controller.signal, timeoutMilliseconds: 5_000 });
  try {
    const pid = await Promise.race([
      started.promise,
      result.then(() => {
        throw new Error("fixture exited before reporting its PID");
      }),
    ]);
    assert(await processExists(pid));
    const rejected = assertRejects(() => result, DOMException);
    controller.abort(new Error("cancel the probe"));
    assertEquals((await rejected).name, "AbortError");
    assertFalse(await processExists(pid), "cancellation returned before the child exited");
  } finally {
    controller.abort();
    await result.catch(() => undefined);
    await server.shutdown();
  }
});

Deno.test("runHiddenCommand removes cancellation listeners on success and command failure", async () => {
  const controller = new AbortController();
  let listeners = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args: Parameters<AbortSignal["addEventListener"]>) => {
    if (args[0] === "abort") listeners++;
    add(...args);
  };
  controller.signal.removeEventListener = (
    ...args: Parameters<AbortSignal["removeEventListener"]>
  ) => {
    if (args[0] === "abort") listeners--;
    remove(...args);
  };
  assertEquals(
    (await runHiddenCommand(Deno.execPath(), ["eval", ""], { signal: controller.signal })).success,
    true,
  );
  assertEquals(listeners, 0);
  await assertRejects(() =>
    runHiddenCommand(`missing-${crypto.randomUUID()}`, [], { signal: controller.signal })
  );
  assertEquals(listeners, 0);
});

async function processExists(pid: number): Promise<boolean> {
  if (Deno.build.os !== "windows") {
    try {
      signalProcess(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  const output = await runHiddenCommand("tasklist", ["/fi", `PID eq ${pid}`, "/nh"]);
  return output.stdout.includes(String(pid));
}
