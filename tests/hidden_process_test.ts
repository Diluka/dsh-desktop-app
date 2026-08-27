import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import {
  isCommandNotFoundError,
  readProcessOutputTail,
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
