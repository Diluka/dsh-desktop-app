import { assert, assertEquals, assertExists, assertFalse, assertMatch } from "@std/assert";
import { basename } from "node:path";
import { createLogger } from "../src/logger.ts";
import { findLogFile, findLogFiles, LOG_FILE_PATTERN } from "./test_helpers.ts";

Deno.test("Pino writes standard JSONL fields and redacts sensitive values", async () => {
  const directory = await Deno.makeTempDir();
  const logger = await createLogger(directory);
  const filePath = await findLogFile(directory);

  const loggedError = Object.assign(new TypeError("boom"), { token: "nested-secret" });
  logger.error({
    event: "ssh.failed",
    detail: `password=hunter2 Authorization: Bearer abc123 ${"y".repeat(4100)}`,
    token: "should-never-be-written",
    err: loggedError,
  }, "Failed to connect");
  logger.error({ event: "app.unhandled_rejection", err: "token=reason-secret" }, "Rejected");
  logger.flush();

  assertMatch(basename(filePath), LOG_FILE_PATTERN);
  const lines = (await Deno.readTextFile(filePath)).trimEnd().split("\n");
  assertEquals(lines.length, 2);
  const entry = JSON.parse(lines[0]);
  assertFalse(Number.isNaN(Date.parse(entry.time)));
  assertEquals(entry.level, 50);
  assertEquals(entry.pid, Deno.pid);
  assertEquals(entry.event, "ssh.failed");
  assertEquals(entry.msg, "Failed to connect");
  assertEquals(entry.token, "[REDACTED]");
  assertEquals(entry.detail.length, 4003);
  assertFalse(entry.detail.includes("hunter2"));
  assertFalse(entry.detail.includes("abc123"));
  assertEquals(entry.err.type, "TypeError");
  assertEquals(entry.err.message, "boom");
  assertEquals(entry.err.token, "[REDACTED]");
  assertExists(entry.err.stack);

  const rejection = JSON.parse(lines[1]);
  assertEquals(rejection.event, "app.unhandled_rejection");
  assertEquals(rejection.err, "token=[REDACTED]");
});

Deno.test("Pino creates a separate file for each logger", async () => {
  const directory = await Deno.makeTempDir();
  const first = await createLogger(directory);
  const second = await createLogger(directory);
  first.info({ event: "session.first" }, "First session");
  second.info({ event: "session.second" }, "Second session");
  first.flush();
  second.flush();

  const files = await findLogFiles(directory);
  assertEquals(files.length, 2);
  const contents = await Promise.all(files.map((file) => Deno.readTextFile(file)));
  assert(contents.some((content) => content.includes('"event":"session.first"')));
  assert(contents.some((content) => content.includes('"event":"session.second"')));
  assertFalse(
    contents.some((content) =>
      content.includes('"event":"session.first"') && content.includes('"event":"session.second"')
    ),
  );
});
