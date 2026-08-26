import SHELL_HTML from "./ui.html" with { type: "text" };

export function handleShellRequest(request: Request): Response {
  const url = new URL(request.url);
  if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
  if (url.pathname !== "/" || (request.method !== "GET" && request.method !== "HEAD")) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(request.method === "HEAD" ? null : SHELL_HTML, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
