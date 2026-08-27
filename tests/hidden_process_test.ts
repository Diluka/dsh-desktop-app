import { assertEquals } from "@std/assert";
import { drainProcessStderr } from "../src/hidden_process.ts";

Deno.test("drainProcessStderr stops capturing while continuing to drain", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const lines: string[] = [];
  let resolveStartupLine!: () => void;
  const startupLine = new Promise<void>((resolve) => {
    resolveStartupLine = resolve;
  });
  const stderr = drainProcessStderr(stream, (line) => {
    lines.push(line);
    resolveStartupLine();
  });
  const encoder = new TextEncoder();

  controller.enqueue(encoder.encode("startup error\n"));
  await startupLine;
  stderr.stopCapturing();
  controller.enqueue(encoder.encode("runtime error\n"));
  controller.close();

  await stderr.done;
  assertEquals(lines, ["startup error"]);
});
