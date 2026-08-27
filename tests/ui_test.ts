import { assertEquals, assertFalse, assertMatch } from "@std/assert";
import SHELL_HTML from "../src/ui.html" with { type: "text" };
import { handleShellRequest } from "../src/ui.ts";

Deno.test("shell html has key elements and parseable inline scripts", () => {
  for (
    const id of [
      "start-local",
      "cancel-local-start",
      "server-form",
      "remote-port",
      "server-list",
      "toast",
    ]
  ) {
    assertMatch(SHELL_HTML, new RegExp(`id="${id}"`, "u"));
  }
  assertMatch(SHELL_HTML, /npx/u);

  const scripts = [...SHELL_HTML.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) =>
    match[1]
  );
  assertEquals(scripts.length, 2);
  for (const script of scripts) new Function(script);
});

Deno.test("shell waits for backend bindings before enabling actions", () => {
  assertMatch(SHELL_HTML, /<button id="start-local"[^>]*disabled>/u);
  assertMatch(SHELL_HTML, /<button id="add-server"[^>]*disabled>/u);
  assertMatch(SHELL_HTML, /<button id="open-log-directory"[^>]*disabled>/u);
  assertMatch(SHELL_HTML, /No binding for 'bootstrap'/u);
  assertMatch(SHELL_HTML, /state\.ready = true/u);
  assertMatch(SHELL_HTML, /function applyBootstrapData\(data\)/u);
  assertEquals([...SHELL_HTML.matchAll(/applyBootstrapData\(data\);/gu)].length, 2);
  assertMatch(
    SHELL_HTML,
    /getElementById\("start-local"\)\.disabled = !environment\.canStart/u,
  );
  assertMatch(SHELL_HTML, /getElementById\("add-server"\)\.disabled = false/u);
  assertMatch(SHELL_HTML, /logButton\.disabled = false/u);
  assertMatch(SHELL_HTML, /logButton\.title = data\.logDirectory/u);
  assertMatch(SHELL_HTML, /<div class="runtime-note">[\s\S]*id="open-log-directory"/u);
  assertFalse(/id="log-directory"/u.test(SHELL_HTML));
});

Deno.test("shell switches between separate remote and local mode panels", () => {
  assertEquals([...SHELL_HTML.matchAll(/class="mode-option"/gu)].length, 2);
  assertMatch(SHELL_HTML, /id="mode-remote"[^>]+aria-pressed="true"/u);
  assertMatch(SHELL_HTML, /id="mode-local"[^>]+aria-pressed="false"/u);
  assertMatch(SHELL_HTML, /id="remote-mode-panel"[^>]*>/u);
  assertMatch(SHELL_HTML, /id="local-mode-panel"[^>]+hidden/u);
  assertMatch(SHELL_HTML, /<h2 id="remote-mode-title">选择服务器<\/h2>/u);
  assertMatch(SHELL_HTML, /<h2 id="local-mode-title">本地模式<\/h2>/u);
  assertMatch(SHELL_HTML, /function setMode\(mode, persist\)/u);
  assertMatch(SHELL_HTML, /localStorage\.getItem\("dsh-desktop-mode"\)/u);
  assertMatch(SHELL_HTML, /localStorage\.setItem\("dsh-desktop-mode", state\.mode\)/u);
  assertMatch(SHELL_HTML, /setMode\(state\.mode, false\)/u);
  for (
    const id of [
      "local-platform",
      "local-node-version",
      "local-dsh-version",
      "local-npx-version",
    ]
  ) {
    assertMatch(SHELL_HTML, new RegExp(`id="${id}"`, "u"));
  }
  assertMatch(SHELL_HTML, /state\.localEnvironment\.launcher === "npx"/u);
  assertMatch(SHELL_HTML, /npx -y @deepseek-ai\/dsh web --host 127\.0\.0\.1/u);
  assertMatch(SHELL_HTML, /dsh web --host 127\.0\.0\.1/u);
});

Deno.test("shell keeps the last connected remote profile first", () => {
  assertMatch(SHELL_HTML, /localStorage\.getItem\("dsh-desktop-last-profile"\)/u);
  assertMatch(
    SHELL_HTML,
    /localStorage\.setItem\("dsh-desktop-last-profile", lastProfileId\)/u,
  );
  assertMatch(SHELL_HTML, /orderedProfiles\.findIndex/u);
  assertMatch(SHELL_HTML, /orderedProfiles\.unshift\(orderedProfiles\.splice/u);
  assertMatch(
    SHELL_HTML,
    /async function connectProfile\(profile\) \{\s*setLastProfile\(profile\.id\)/u,
  );
  assertMatch(SHELL_HTML, /if \(lastProfileId === profile\.id\) setLastProfile\(null\)/u);
});

Deno.test("shell renders Unicode delete confirmation in-page", () => {
  assertFalse(/\bconfirm\s*\(/u.test(SHELL_HTML));
  assertMatch(
    SHELL_HTML,
    /<dialog id="delete-confirmation"[^>]+aria-modal="true"[^>]*>/u,
  );
  assertMatch(SHELL_HTML, /<form class="form-actions" method="dialog">/u);
  assertMatch(SHELL_HTML, /deleteConfirmationMessage\.textContent =/u);
});

Deno.test("handleShellRequest serves safe shell responses without local tunnel internals", async () => {
  const get = handleShellRequest(new Request("http://desktop.local/"));
  assertEquals(get.status, 200);
  assertEquals(get.headers.get("content-type"), "text/html; charset=utf-8");
  assertEquals(get.headers.get("cache-control"), "no-store");
  assertEquals(get.headers.get("x-content-type-options"), "nosniff");
  assertEquals(get.headers.get("referrer-policy"), "no-referrer");
  assertEquals(
    get.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  );
  assertEquals(await get.text(), SHELL_HTML);

  const head = handleShellRequest(new Request("http://desktop.local/", { method: "HEAD" }));
  assertEquals(head.status, 200);
  assertEquals(await head.text(), "");

  assertEquals(handleShellRequest(new Request("http://desktop.local/nope")).status, 404);
  assertEquals(
    handleShellRequest(new Request("http://desktop.local/", { method: "POST" })).status,
    404,
  );

  assertFalse(SHELL_HTML.includes("http://127.0.0.1:"));
  assertFalse(SHELL_HTML.includes("localhost:"));
  assertFalse(SHELL_HTML.includes("localPort"));
  assertFalse(SHELL_HTML.includes("tunnel.url"));
});
