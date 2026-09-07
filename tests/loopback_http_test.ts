import { assertEquals, assertFalse, assertRejects } from "@std/assert";
import { probeHttp } from "../src/loopback_http.ts";

Deno.test("probeHttp can return an HTML probe response status", async () => {
  const accepts: string[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, (request) => {
    accepts.push(request.headers.get("accept") ?? "");
    const pathname = new URL(request.url).pathname;
    const status = pathname === "/login" ? 401 : 200;
    return new Response("probe", { status });
  });
  const port = (server.addr as Deno.NetAddr).port;
  try {
    const options = { accept: "text/html", validateStatus: () => true };
    assertEquals(await probeHttp(`http://127.0.0.1:${port}/ok`, options), 200);
    assertEquals(await probeHttp(`http://127.0.0.1:${port}/login`, options), 401);
    assertEquals(accepts, ["text/html", "text/html"]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("probeHttp pre-cancellation does not issue a request", async () => {
  const controller = new AbortController();
  controller.abort(new Error("arbitrary reason"));
  // An invalid URL would throw TypeError if fetch were reached.
  const error = await assertRejects(
    () => probeHttp("not-a-url", { signal: controller.signal }),
    DOMException,
  );
  assertEquals(error.name, "AbortError");
});

for (const cause of ["cancel", "timeout"] as const) {
  Deno.test(`probeHttp interrupts an in-flight request on ${cause}`, async () => {
    const controller = new AbortController();
    const deadline = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalTimeout = AbortSignal.timeout;
    if (cause === "timeout") {
      AbortSignal.timeout = (ms) => {
        assertEquals(ms, 1_500);
        return deadline.signal;
      };
    }
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async () => {
      entered.resolve();
      await release.promise;
      return new Response("done");
    });
    const result = probeHttp(`http://127.0.0.1:${server.addr.port}`, { signal: controller.signal });
    try {
      const rejected = assertRejects(() => result, DOMException);
      await entered.promise;
      if (cause === "cancel") controller.abort(new Error("not AbortError"));
      else deadline.abort(new DOMException("deadline", "TimeoutError"));
      assertEquals((await rejected).name, cause === "cancel" ? "AbortError" : "TimeoutError");
      if (cause === "timeout") assertFalse(controller.signal.aborted);
    } finally {
      controller.abort();
      release.resolve();
      await result.catch(() => undefined);
      await server.shutdown();
      AbortSignal.timeout = originalTimeout;
    }
  });
}

Deno.test("probeHttp accepts only successful or redirect responses by default", async () => {
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, (request) => {
    const pathname = new URL(request.url).pathname;
    const status = pathname === "/ok"
      ? 200
      : pathname === "/empty"
      ? 204
      : pathname === "/redirect"
      ? 302
      : pathname === "/cached"
      ? 304
      : 404;
    const body = status === 204 || status === 304 ? null : "probe";
    return new Response(body, { status });
  });
  const port = (server.addr as Deno.NetAddr).port;
  try {
    assertEquals(await probeHttp(`http://127.0.0.1:${port}/ok`), 200);
    assertEquals(await probeHttp(`http://127.0.0.1:${port}/empty`), 204);
    assertEquals(await probeHttp(`http://127.0.0.1:${port}/redirect`), 302);
    assertEquals(await probeHttp(`http://127.0.0.1:${port}/cached`), 304);
    await assertRejects(() => probeHttp(`http://127.0.0.1:${port}/missing`));
  } finally {
    await server.shutdown();
  }
});
