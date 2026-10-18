import { assertEquals, assertFalse, assertMatch } from "@std/assert";
import SHELL_HTML from "../src/ui.html" with { type: "text" };
import { handleShellRequest } from "../src/ui.ts";

Deno.test("shell html has key elements and parseable inline scripts", () => {
  for (
    const id of [
      "server-panel",
      "server-panel-title",
      "server-form",
      "remote-port",
      "dsh-web-token",
      "dsh-web-token-prompt",
      "server-list",
      "toast",
      "update-banner",
      "update-open-release",
      "update-dismiss",
    ]
  ) {
    assertMatch(SHELL_HTML, new RegExp(`id="${id}"`, "u"));
  }
  assertMatch(SHELL_HTML, /name="dshWebToken" type="password"/u);
  assertMatch(SHELL_HTML, /dshWebToken: form\.elements\.dshWebToken\.value/u);
  assertMatch(SHELL_HTML, /function promptForDshWebToken\(profile, message\)/u);
  assertMatch(SHELL_HTML, /requiresDshWebToken\(error\)/u);
  assertMatch(SHELL_HTML, /error\.code === "DSH_LOGIN_REQUIRED"/u);
  assertMatch(SHELL_HTML, /form\.elements\.dshWebToken\.focus\(\)/u);
  assertMatch(SHELL_HTML, /需要时尝试恢复 DSH Web token/u);

  const scripts = [...SHELL_HTML.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) =>
    match[1]
  );
  assertEquals(scripts.length, 2);
  for (const script of scripts) new Function(script);
});

Deno.test("shell renders a single remote server panel", () => {
  assertMatch(SHELL_HTML, /<section id="server-panel" aria-labelledby="server-panel-title">/u);
  assertMatch(SHELL_HTML, /<h2 id="server-panel-title">选择服务器<\/h2>/u);
  assertMatch(SHELL_HTML, /通过 SSH Host 建立安全连接。/u);
  assertMatch(SHELL_HTML, /id="add-server"[^>]*disabled>/u);
  assertMatch(SHELL_HTML, /id="open-log-directory"/u);
  assertEquals([...SHELL_HTML.matchAll(/<section id="[^"]+-panel"/gu)].length, 1);

  const connecting = SHELL_HTML.slice(SHELL_HTML.indexOf('id="connecting"'));
  assertMatch(connecting, /正在准备远程连接/u);
  assertEquals([...connecting.matchAll(/<li>/gu)].length, 4);
  assertMatch(connecting, /<li>读取本机 \.ssh\/config<\/li>/u);
  assertMatch(connecting, /<li>建立回环端口转发<\/li>/u);
  assertMatch(connecting, /<li>验证远端 DSH Web<\/li>/u);
  assertMatch(connecting, /<li>需要时尝试恢复 DSH Web token<\/li>/u);
});

Deno.test("shell has no local DSH mode leftovers", () => {
  for (
    const needle of [
      "local-mode",
      "mode-panel",
      "mode-option",
      "mode-remote",
      "mode-local",
      "masthead-modes",
      "start-local",
      "cancel-local-start",
      "connecting-actions",
      "connectLocal",
      "cancelLocalStart",
      "localEnvironment",
      "setModePreference",
      "setMode(",
      "state.mode",
      "data.mode",
      "data.localEnvironment",
      "npx",
      "connection-backend",
      "local-platform",
      "local-node-version",
      "local-dsh-version",
      "local-npx-version",
      "local-powershell",
      "local-start-description",
      "diagnostic-note",
    ]
  ) {
    assertFalse(SHELL_HTML.includes(needle), `unexpected leftover: ${needle}`);
  }
  assertFalse(/\bmode\b/iu.test(SHELL_HTML));
});

Deno.test("shell waits for backend bindings before enabling actions", () => {
  assertMatch(SHELL_HTML, /<button id="add-server"[^>]*disabled>/u);
  assertMatch(SHELL_HTML, /<button id="open-log-directory"[^>]*disabled>/u);
  assertMatch(SHELL_HTML, /No binding for 'bootstrap'/u);
  assertMatch(SHELL_HTML, /state\.ready = true/u);
  assertMatch(SHELL_HTML, /function applyBootstrapData\(data\)/u);
  assertEquals([...SHELL_HTML.matchAll(/applyBootstrapData\(data\);/gu)].length, 2);
  assertMatch(SHELL_HTML, /if \(!state\.profiles\.length\) openEditor\(\);/u);
  assertMatch(SHELL_HTML, /getElementById\("add-server"\)\.disabled = false/u);
  assertMatch(SHELL_HTML, /logButton\.disabled = false/u);
  assertMatch(SHELL_HTML, /logButton\.title = data\.logDirectory/u);
  assertMatch(SHELL_HTML, /<div class="runtime-note">[\s\S]*id="open-log-directory"/u);
  assertMatch(SHELL_HTML, /<div id="update-banner"[^>]*hidden>/u);
  assertMatch(SHELL_HTML, /id="update-open-release"/u);
  assertMatch(SHELL_HTML, /function checkForUpdate\(\)/u);
  assertMatch(SHELL_HTML, /openUpdateReleasePage\(\)/u);
  assertMatch(SHELL_HTML, /updateDismissed = true/u);
  assertFalse(/id="log-directory"/u.test(SHELL_HTML));
});

Deno.test("shell bootstrap contract omits mode and local environment fields", () => {
  assertMatch(SHELL_HTML, /state\.profiles = data\.profiles;/u);
  assertMatch(SHELL_HTML, /state\.ssh = data\.ssh;/u);
  assertMatch(SHELL_HTML, /state\.updatesSupported = Boolean\(data\.updatesSupported\);/u);
  assertMatch(SHELL_HTML, /data\.browserBackend/u);
  assertMatch(SHELL_HTML, /data\.logDirectory/u);
  assertFalse(/\bdata\.mode\b/u.test(SHELL_HTML));
  assertFalse(/\bdata\.localEnvironment\b/u.test(SHELL_HTML));
  for (const binding of ["setModePreference", "connectLocal", "cancelLocalStart"]) {
    assertFalse(SHELL_HTML.includes(binding), `unexpected binding: ${binding}`);
  }
  for (
    const binding of [
      "saveProfile",
      "deleteProfile",
      "openLogDirectory",
      "checkForUpdate",
      "openUpdateReleasePage",
      "connectProfile",
    ]
  ) {
    assertMatch(SHELL_HTML, new RegExp(`bindings\\.${binding}\\(`, "u"));
  }
});

Deno.test("shell renders Unicode delete confirmation in-page", () => {
  assertFalse(/\bconfirm\s*\(/u.test(SHELL_HTML));
  assertMatch(
    SHELL_HTML,
    /<dialog id="delete-confirmation"[^>]+aria-modal="true"[^>]*>/u,
  );
  assertMatch(SHELL_HTML, /<form class="form-actions" method="dialog">/u);
  assertMatch(SHELL_HTML, /deleteConfirmationMessage\.textContent =/u);
  assertFalse(/update-confirmation/u.test(SHELL_HTML));
  assertMatch(SHELL_HTML, /function hideUpdateBanner\(/u);
  assertMatch(SHELL_HTML, /function openUpdateReleasePage\(/u);
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
