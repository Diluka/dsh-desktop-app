import { join } from "node:path";
import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
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
  // cmd.exe stays alive while its deno descendant runs, so the spawned child is
  // an intermediary process and its descendant must not survive kill.
  const script = join(directory, "long-running.js");
  await Deno.writeTextFile(
    script,
    "console.log('DESCENDANT_PID=' + Deno.pid); setInterval(() => {}, 1000);\n",
  );

  const child = spawnHiddenProcess("cmd.exe", ["/c", Deno.execPath(), "run", script], directory);
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

async function processExists(pid: number): Promise<boolean> {
  const output = await runHiddenCommand("tasklist", ["/fi", `PID eq ${pid}`, "/nh"]);
  return output.stdout.includes(String(pid));
}
