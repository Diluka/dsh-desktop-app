import { assertEquals, assertFalse, assertMatch, assertStringIncludes } from "@std/assert";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import SHELL_HTML from "../src/ui.html" with { type: "text" };
import { handleShellRequest } from "../src/ui.ts";

Deno.test("shell html has key elements and parseable inline scripts", () => {
  for (
    const id of [
      "start-local",
      "cancel-local-start",
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
  assertMatch(SHELL_HTML, /npx/u);
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
  assertMatch(SHELL_HTML, /<div id="update-banner"[^>]*hidden>/u);
  assertMatch(SHELL_HTML, /id="update-open-release"/u);
  assertMatch(SHELL_HTML, /function checkForUpdate\(\)/u);
  assertMatch(SHELL_HTML, /openUpdateReleasePage\(\)/u);
  assertMatch(SHELL_HTML, /updateDismissed = true/u);
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
  assertMatch(SHELL_HTML, /bindings\.setModePreference\(state\.mode\)/u);
  assertMatch(SHELL_HTML, /setMode\(data\.mode, false\)/u);
  assertFalse(/dsh-desktop-(?:mode|last-profile)/u.test(SHELL_HTML));
  for (
    const id of [
      "local-platform",
      "local-node-version",
      "local-dsh-version",
      "local-npx-version",
      "local-powershell-version",
    ]
  ) {
    assertMatch(SHELL_HTML, new RegExp(`id="${id}"`, "u"));
  }
  assertMatch(SHELL_HTML, /environment\.powershell\.pwshAvailable/u);
  assertMatch(SHELL_HTML, /state\.localEnvironment\.launcher === "npx"/u);
  assertMatch(SHELL_HTML, /npx -y @deepseek-ai\/dsh web --host 127\.0\.0\.1/u);
  assertMatch(SHELL_HTML, /dsh web --host 127\.0\.0\.1/u);
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

// Deliberately small platform doubles, not a second implementation of the UI.
// IDs/attributes come from the shipped HTML; missing elements/selectors fail fast.
class ShellElement {
  hidden = false;
  disabled = false;
  value = "";
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  elements: Record<string, ShellElement> = {};
  children: ShellElement[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<() => unknown>>();
  private text = "";
  classList = {
    toggle: (name: string, enabled: boolean) => this.toggleAttribute(`class:${name}`, enabled),
  };

  constructor(private onFocus: (element: ShellElement) => void) {}

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  get lastElementChild() {
    return this.children.at(-1);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  toggleAttribute(name: string, enabled: boolean) {
    if (enabled) this.attributes.set(name, "");
    else this.attributes.delete(name);
    return enabled;
  }
  append(...children: ShellElement[]) {
    this.children.push(...children);
  }
  appendChild(child: ShellElement) {
    this.append(child);
    return child;
  }
  replaceChildren(...children: ShellElement[]) {
    this.text = "";
    this.children = children;
  }
  addEventListener(event: string, listener: () => unknown) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  async click() {
    if (this.disabled) return;
    const listeners = this.listeners.get("click");
    if (!listeners?.length) throw new Error("No click listener registered");
    await Promise.all(listeners.map((listener) => listener()));
  }
  focus() {
    this.onFocus(this);
  }
}

interface ShellReconnectState {
  active: boolean;
  profileId: string;
  message: string;
  errorCode?: string;
}

const reconnectFixture: ShellReconnectState = {
  active: true,
  profileId: "retry-target",
  message: "连接中断，将进行第 1/5 次重连",
};
const reconnectProfile = {
  id: "retry-target",
  name: "Synthetic remote",
  sshTarget: "fake-host",
  remotePort: 3080,
  dshWebToken: "fake-saved-token",
};

async function createShellHarness(options: {
  poll?: () => Promise<ShellReconnectState | null>;
  cancel?: () => Promise<unknown>;
  connect?: (id: string) => Promise<unknown>;
} = {}) {
  let focused: ShellElement | undefined;
  const createElement = () => new ShellElement((element) => focused = element);
  const byId = new Map<string, ShellElement>();
  const all: ShellElement[] = [];
  const fields: Record<string, ShellElement> = {};
  for (const [, attributes] of SHELL_HTML.matchAll(/<[a-z][\w-]*\b([^>]*)>/gu)) {
    const element = createElement();
    all.push(element);
    for (const [, name, value] of attributes.matchAll(/([\w-]+)="([^"]*)"/gu)) {
      element.setAttribute(name, value);
      if (name === "id") byId.set(value, element);
      if (name === "name") fields[value] = element;
      if (name === "value") element.value = value;
      if (name === "class") element.className = value;
      if (name.startsWith("data-")) {
        const key = name.slice(5).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
        element.dataset[key] = value;
      }
    }
    element.hidden = /\bhidden(?:\s|$)/u.test(attributes);
    element.disabled = /\bdisabled(?:\s|$)/u.test(attributes);
  }
  const element = (id: string) => {
    const found = byId.get(id);
    if (!found) throw new Error(`Missing shell element: ${id}`);
    return found;
  };
  element("server-form").elements = fields;
  element("ssh-status").append(createElement());
  const steps = Array.from({ length: 4 }, createElement);
  const document = {
    documentElement: createElement(),
    getElementById: element,
    createElement,
    querySelectorAll(selector: string) {
      if (selector === ".connecting-steps li") return steps;
      if (selector === ".mode-option" || selector === ".theme-option") {
        return all.filter((item) => item.className.split(" ").includes(selector.slice(1)));
      }
      throw new Error(`Unsupported selector: ${selector}`);
    },
  };
  let timerId = 0;
  const timers = new Map<number, { callback: () => unknown; delay: number }>();
  const calls = { bootstrap: 0, poll: 0, cancel: 0, connect: [] as string[] };
  const bindings = {
    bootstrap() {
      calls.bootstrap++;
      return Promise.resolve({
        // Put a different profile first to catch retrying the wrong server.
        profiles: [{ ...reconnectProfile, id: "other-profile" }, reconnectProfile],
        ssh: { available: true, version: "OpenSSH fixture" },
        localEnvironment: { canStart: false, platform: "fixture" },
        mode: "remote",
        updatesSupported: false,
        logDirectory: "fixture-logs",
        browserBackend: "fixture",
        reconnect: { ...reconnectFixture },
      });
    },
    getReconnectState() {
      calls.poll++;
      return options.poll?.() ?? Promise.resolve(null);
    },
    cancelReconnect() {
      calls.cancel++;
      return options.cancel?.() ?? Promise.resolve();
    },
    connectProfile(id: string) {
      calls.connect.push(id);
      return options.connect?.(id) ?? Promise.resolve();
    },
  };
  const platform = {
    document,
    bindings,
    localStorage: { getItem: () => null },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setTimeout(callback: () => unknown, delay: number) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
  };
  // Execute both original inline scripts, including their real bootstrap and
  // event registration. No internals are exported or rewritten for these tests.
  const scripts = [...SHELL_HTML.matchAll(/<script>([\s\S]*?)<\/script>/gu)];
  assertEquals(scripts.length, 2);
  runInNewContext(scripts.map((match) => match[1]).join("\n"), {
    ...platform,
    window: platform,
  }, { timeout: 1_000 });
  // Drain cross-realm promise assimilation without advancing any UI timers.
  await setImmediate();
  assertEquals(calls.bootstrap, 1);
  assertFalse(element("reconnect-panel").hidden, element("notice").textContent);

  return {
    element,
    calls,
    get focused() {
      return focused;
    },
    get timerDelays() {
      return [...timers.values()].map((timer) => timer.delay);
    },
    async runTimer(delay: number) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      if (!entry) throw new Error(`No pending ${delay}ms timer`);
      timers.delete(entry[0]);
      await entry[1].callback();
    },
  };
}

Deno.test("shell reconnect bootstrap displays progress and polls until recovery ends", async () => {
  let progress: ShellReconnectState | null = {
    ...reconnectFixture,
    message: "正在进行第 2/5 次重连",
  };
  const shell = await createShellHarness({ poll: () => Promise.resolve(progress) });
  assertEquals(shell.element("reconnect-message").textContent, reconnectFixture.message);
  assertFalse(shell.element("reconnect-cancel").hidden);
  assertEquals(shell.element("reconnect-now").textContent, "立即重试");
  assertEquals(shell.calls.poll, 0);
  assertEquals(shell.timerDelays, [500]);

  await shell.runTimer(500);
  assertEquals(shell.calls.poll, 1);
  assertEquals(shell.element("reconnect-message").textContent, progress.message);
  assertEquals(shell.timerDelays, [500]);
  progress = null;
  await shell.runTimer(500);
  assertEquals(shell.calls.poll, 2);
  assertEquals(shell.element("reconnect-panel").hidden, true);
  assertEquals(shell.timerDelays, []);
});

Deno.test("shell reconnect cancel calls backend then hides panel and stops polling", async () => {
  const cancelled = Promise.withResolvers<void>();
  const shell = await createShellHarness({ cancel: () => cancelled.promise });
  const click = shell.element("reconnect-cancel").click();
  assertEquals(shell.calls.cancel, 1);
  assertEquals(shell.element("reconnect-cancel").disabled, true);
  assertFalse(shell.element("reconnect-panel").hidden);

  cancelled.resolve();
  await click;
  assertFalse(shell.element("reconnect-cancel").disabled);
  assertEquals(shell.element("reconnect-panel").hidden, true);
  assertFalse(shell.element("notice").hidden);
  assertStringIncludes(shell.element("notice").textContent, "已取消自动重连");
  assertEquals(shell.timerDelays, []);
  assertEquals(shell.calls.connect, []);
});

Deno.test("shell reconnect retry connects the indicated profile immediately", async () => {
  const shell = await createShellHarness();
  await shell.element("reconnect-now").click();
  assertEquals(shell.calls.connect, [reconnectProfile.id]);
  assertEquals(shell.calls.poll, 0);
  assertEquals(shell.element("reconnect-panel").hidden, true);
  assertEquals(shell.timerDelays, []);
  assertFalse(shell.element("connecting").hidden);
  assertStringIncludes(shell.element("connecting-target").textContent, reconnectProfile.name);
});

Deno.test("shell terminal reconnect login failure opens the matching token editor", async () => {
  const message = "Enter a new token";
  const shell = await createShellHarness({
    poll: () =>
      Promise.resolve({
        ...reconnectFixture,
        active: false,
        errorCode: "DSH_LOGIN_REQUIRED",
        message,
      }),
  });
  await shell.runTimer(500);
  assertEquals(shell.element("reconnect-now").textContent, "更新 token");
  assertEquals(shell.element("reconnect-cancel").hidden, true);
  assertEquals(shell.timerDelays, []);
  await shell.element("reconnect-now").click();
  assertFalse(shell.element("editor").hidden);
  assertEquals(shell.element("editor-title").textContent, "更新 DSH Web token");
  assertEquals(shell.element("ssh-target").value, reconnectProfile.sshTarget);
  assertEquals(shell.element("server-name").value, reconnectProfile.name);
  assertEquals(shell.element("dsh-web-token").value, "");
  assertFalse(shell.element("dsh-web-token-prompt").hidden);
  assertEquals(shell.element("dsh-web-token-prompt").textContent, message);
  await shell.runTimer(0);
  await shell.runTimer(0);
  assertEquals(shell.focused, shell.element("dsh-web-token"));
  assertEquals(shell.calls.connect, []);
});

Deno.test("shell immediate reconnect login rejection opens token editor without overlay", async () => {
  const shell = await createShellHarness({
    connect: () => Promise.reject({ code: "DSH_LOGIN_REQUIRED", message: "Token rejected" }),
  });
  await shell.element("reconnect-now").click();
  assertEquals(shell.calls.connect, [reconnectProfile.id]);
  assertEquals(shell.element("connecting").hidden, true);
  assertFalse(shell.element("editor").hidden);
  assertEquals(shell.element("dsh-web-token").value, "");
  assertEquals(shell.element("dsh-web-token-prompt").textContent, "Token rejected");
});

Deno.test("shell reconnect render revision rejects a stale poll after cancellation", async () => {
  const pending = Promise.withResolvers<ShellReconnectState>();
  const shell = await createShellHarness({ poll: () => pending.promise });
  const polling = shell.runTimer(500);
  assertEquals(shell.calls.poll, 1);
  await shell.element("reconnect-cancel").click();
  assertEquals(shell.element("reconnect-panel").hidden, true);
  const cancelledNotice = shell.element("notice").textContent;

  pending.resolve({ ...reconnectFixture, message: "Stale progress must not reappear" });
  await polling;
  assertEquals(shell.element("reconnect-panel").hidden, true);
  assertFalse(shell.element("notice").hidden);
  assertEquals(shell.element("notice").textContent, cancelledNotice);
  assertEquals(shell.timerDelays, []);
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
