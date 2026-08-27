import { assertRejects } from "@std/assert";
import { probeHttp } from "../src/loopback_http.ts";

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
