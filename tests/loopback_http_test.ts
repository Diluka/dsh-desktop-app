import { assertEquals, assertRejects } from "@std/assert";
import { probeHtmlStatus, probeHttp } from "../src/loopback_http.ts";

Deno.test("probeHtmlStatus returns the HTML probe response status", async () => {
  const accepts: string[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, (request) => {
    accepts.push(request.headers.get("accept") ?? "");
    const pathname = new URL(request.url).pathname;
    const status = pathname === "/login" ? 401 : 200;
    return new Response("probe", { status });
  });
  const port = (server.addr as Deno.NetAddr).port;
  try {
    assertEquals(await probeHtmlStatus(`http://127.0.0.1:${port}/ok`), 200);
    assertEquals(await probeHtmlStatus(`http://127.0.0.1:${port}/login`), 401);
    assertEquals(accepts, ["text/html", "text/html"]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("probeHttp accepts only successful or redirect responses", async () => {
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
    await probeHttp(`http://127.0.0.1:${port}/ok`);
    await probeHttp(`http://127.0.0.1:${port}/empty`);
    await probeHttp(`http://127.0.0.1:${port}/redirect`);
    await probeHttp(`http://127.0.0.1:${port}/cached`);
    await assertRejects(() => probeHttp(`http://127.0.0.1:${port}/missing`));
  } finally {
    await server.shutdown();
  }
});
