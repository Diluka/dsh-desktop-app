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
      "reconnect-panel",
      "reconnect-now",
      "dsh-connection-panel",
      "dsh-retry",
      "dsh-cancel",
      "dsh-update-token",
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
  listeners = new Map<string, Array<(event: { preventDefault(): void }) => unknown>>();
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
  addEventListener(event: string, listener: (event: { preventDefault(): void }) => unknown) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  async dispatch(type: string) {
    const listeners = this.listeners.get(type);
    if (!listeners?.length) throw new Error(`No ${type} listener registered`);
    let prevented = false;
    const event = { preventDefault: () => prevented = true };
    await Promise.all(listeners.map((listener) => listener(event)));
    if (type === "submit") assertEquals(prevented, true);
  }
  async click() {
    if (!this.disabled) await this.dispatch("click");
  }
  querySelector(selector: string) {
    if (selector === 'button[type="submit"]') {
      return this.children.find((child) => child.attributes.get("type") === "submit");
    }
    throw new Error(`Unsupported element selector: ${selector}`);
  }
  reset() {
    for (const field of Object.values(this.elements)) {
      field.value = field.attributes.get("value") ?? "";
    }
  }
  focus() {
    this.onFocus(this);
  }
}

interface ShellLayerState {
  active: boolean;
  profileId: string;
  message: string;
  errorCode?: string;
}

interface ShellRemoteState {
  reconnect: ShellLayerState | null;
  dsh: ShellLayerState | null;
  remoteActive: boolean;
}

function remoteFixture(overrides: Partial<ShellRemoteState> = {}): ShellRemoteState {
  return { reconnect: null, dsh: null, remoteActive: true, ...overrides };
}

const reconnectFixture: ShellLayerState = {
  active: true,
  profileId: "retry-target",
  message: "SSH 进程已退出，等待重新创建",
};
const sshRunningFixture: ShellLayerState = {
  ...reconnectFixture,
  active: false,
  message: "SSH process is running",
};
const reconnectProfile = {
  id: "retry-target",
  name: "Synthetic remote",
  sshTarget: "fake-host",
  remotePort: 3080,
  dshWebToken: "fake-saved-token",
};

const dshLoginFixture: ShellLayerState = {
  active: false,
  profileId: reconnectProfile.id,
  errorCode: "DSH_LOGIN_REQUIRED",
  message: "DSH returned 401; enter a new token",
};

async function createShellHarness(options: {
  initial?: ShellRemoteState;
  poll?: () => Promise<ShellRemoteState>;
  cancel?: () => Promise<unknown>;
  retryDsh?: () => Promise<unknown>;
  cancelDsh?: () => Promise<unknown>;
  connect?: (id: string) => Promise<unknown>;
  save?: () => Promise<unknown>;
} = {}) {
  let focused: ShellElement | undefined;
  const createElement = () => new ShellElement((element) => focused = element);
  const byId = new Map<string, ShellElement>();
  const all: ShellElement[] = [];
  const fields: Record<string, ShellElement> = {};
  for (const [, attributes, text] of SHELL_HTML.matchAll(/<[a-z][\w-]*\b([^>]*)>([^<]*)/gu)) {
    const element = createElement();
    element.textContent = text.trim();
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
  const submit = all.find((item) => item.attributes.get("type") === "submit");
  if (!submit) throw new Error("Missing profile submit button");
  element("server-form").append(submit);
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
  let remoteState = options.initial ?? remoteFixture({ reconnect: { ...reconnectFixture } });
  const calls = {
    bootstrap: 0,
    poll: 0,
    cancel: 0,
    retryDsh: 0,
    cancelDsh: 0,
    connect: [] as string[],
    savedProfiles: [] as Array<typeof reconnectProfile>,
  };
  const bindings = {
    bootstrap() {
      calls.bootstrap++;
      return Promise.resolve({
        // Put a different profile first to catch retrying the wrong server.
        profiles: [
          {
            ...reconnectProfile,
            id: "other-profile",
            name: "Other remote",
            sshTarget: "other-host",
          },
          reconnectProfile,
        ],
        ssh: { available: true, version: "OpenSSH fixture" },
        localEnvironment: { canStart: false, platform: "fixture" },
        mode: "remote",
        updatesSupported: false,
        logDirectory: "fixture-logs",
        browserBackend: "fixture",
        ...remoteState,
      });
    },
    getRemoteConnectionState() {
      calls.poll++;
      return options.poll?.() ?? Promise.resolve(remoteState);
    },
    retryDshConnection() {
      calls.retryDsh++;
      return options.retryDsh?.() ?? Promise.resolve();
    },
    cancelDshConnection() {
      calls.cancelDsh++;
      return options.cancelDsh?.() ?? Promise.resolve();
    },
    saveProfile(profile: typeof reconnectProfile) {
      calls.savedProfiles.push({ ...profile });
      return options.save?.() ?? Promise.resolve();
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
  assertFalse(element("add-server").disabled, element("notice").textContent);

  return {
    element,
    calls,
    setRemoteState(value: ShellRemoteState) {
      remoteState = value;
    },
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

Deno.test("shell SSH bootstrap polls process progress until remote ownership ends", async () => {
  const shell = await createShellHarness();
  assertEquals(shell.element("reconnect-message").textContent, reconnectFixture.message);
  assertFalse(shell.element("reconnect-cancel").hidden);
  assertEquals(shell.element("dsh-connection-panel").hidden, true);
  assertEquals(shell.calls.poll, 0);
  assertEquals(shell.timerDelays, [500]);

  shell.setRemoteState(remoteFixture({
    reconnect: { ...reconnectFixture, message: "正在重新创建 SSH 进程" },
  }));
  await shell.runTimer(500);
  assertEquals(shell.calls.poll, 1);
  assertEquals(shell.element("reconnect-message").textContent, "正在重新创建 SSH 进程");
  assertEquals(shell.timerDelays, [500]);
  shell.setRemoteState(remoteFixture({ remoteActive: false }));
  await shell.runTimer(500);
  assertEquals(shell.calls.poll, 2);
  assertEquals(shell.element("reconnect-panel").hidden, true);
  assertEquals(shell.timerDelays, []);
});

Deno.test("shell explicit SSH cancel hides both layers and stops remote polling", async () => {
  const cancelled = Promise.withResolvers<void>();
  const shell = await createShellHarness({ cancel: () => cancelled.promise });
  const click = shell.element("reconnect-cancel").click();
  assertEquals(shell.calls.cancel, 1);
  assertEquals(shell.element("reconnect-cancel").disabled, true);
  cancelled.resolve();
  await click;
  assertFalse(shell.element("reconnect-cancel").disabled);
  assertEquals(shell.element("reconnect-panel").hidden, true);
  assertEquals(shell.element("dsh-connection-panel").hidden, true);
  assertFalse(shell.element("notice").hidden);
  assertStringIncludes(shell.element("notice").textContent, "已取消 SSH 进程重建");
  assertEquals(shell.timerDelays, []);
  assertEquals(shell.calls.connect, []);
  assertEquals(shell.calls.cancelDsh, 0);
});

Deno.test("shell SSH retry hides overlay after process start and renders separate layer state", async () => {
  const connected = Promise.withResolvers<void>();
  const shell = await createShellHarness({ connect: () => connected.promise });
  await shell.element("reconnect-now").click();
  assertEquals(shell.calls.connect, [reconnectProfile.id]);
  assertEquals(shell.calls.retryDsh, 0);
  assertEquals(shell.calls.poll, 0);
  assertFalse(shell.element("connecting").hidden);
  assertStringIncludes(shell.element("connecting-target").textContent, reconnectProfile.name);

  shell.setRemoteState(remoteFixture({
    reconnect: sshRunningFixture,
    dsh: { ...dshLoginFixture, active: true, errorCode: undefined, message: "Checking DSH only" },
  }));
  connected.resolve();
  await setImmediate();
  assertEquals(shell.element("connecting").hidden, true);
  assertFalse(shell.element("reconnect-panel").hidden);
  assertEquals(shell.element("reconnect-message").textContent, sshRunningFixture.message);
  assertEquals(shell.element("reconnect-now").hidden, true);
  assertFalse(shell.element("dsh-connection-panel").hidden);
  assertEquals(shell.element("dsh-connection-message").textContent, "Checking DSH only");
  assertEquals(shell.calls.poll, 1);
  assertEquals(shell.timerDelays, [500]);
});

for (const errorCode of ["DSH_LOGIN_REQUIRED", "DSH_UNAVAILABLE"]) {
  Deno.test(`shell ${errorCode} stays in DSH panel and still observes later SSH exit`, async () => {
    const shell = await createShellHarness({
      initial: remoteFixture({
        reconnect: sshRunningFixture,
        dsh: { ...dshLoginFixture, errorCode },
      }),
    });
    assertFalse(shell.element("reconnect-panel").hidden);
    assertEquals(shell.element("reconnect-now").hidden, true);
    assertFalse(shell.element("dsh-connection-panel").hidden);
    assertEquals(shell.element("dsh-update-token").hidden, errorCode !== "DSH_LOGIN_REQUIRED");
    assertEquals(shell.element("dsh-cancel").hidden, true);
    assertEquals(shell.element("editor").hidden, true);
    assertEquals(shell.timerDelays, [500]);
    assertEquals(shell.calls.connect, []);
    assertEquals(shell.calls.cancel, 0);

    shell.setRemoteState(remoteFixture({ reconnect: reconnectFixture }));
    await shell.runTimer(500);
    assertFalse(shell.element("reconnect-panel").hidden);
    assertFalse(shell.element("reconnect-now").hidden);
    assertEquals(shell.element("reconnect-message").textContent, reconnectFixture.message);
    assertEquals(shell.element("dsh-connection-panel").hidden, true);
    assertEquals(shell.timerDelays, [500]);
    assertEquals(shell.calls.connect, []); // Backend supervises exits; polling does not spawn.
  });
}

Deno.test("shell DSH manual retry only calls DSH binding on the retained SSH process", async () => {
  const retried = Promise.withResolvers<void>();
  const shell = await createShellHarness({
    initial: remoteFixture({ dsh: dshLoginFixture }),
    retryDsh: () => retried.promise,
  });
  const click = shell.element("dsh-retry").click();
  assertEquals(shell.calls.retryDsh, 1);
  assertEquals(shell.element("dsh-retry").disabled, true);
  shell.setRemoteState(remoteFixture({
    dsh: { ...dshLoginFixture, active: true, errorCode: undefined, message: "Retrying DSH" },
  }));
  retried.resolve();
  await click;
  assertFalse(shell.element("dsh-retry").disabled);
  assertEquals(shell.element("dsh-connection-message").textContent, "Retrying DSH");
  assertEquals(shell.element("dsh-update-token").hidden, true);
  assertEquals(shell.element("reconnect-panel").hidden, true);
  assertEquals(shell.calls.connect, []);
  assertEquals(shell.calls.cancel, 0);
  assertEquals(shell.calls.cancelDsh, 0);
  assertEquals(shell.timerDelays, [500]);
});

Deno.test("shell DSH cancellation retains process polling without SSH cancellation or restart", async () => {
  const cancelled = Promise.withResolvers<void>();
  const shell = await createShellHarness({
    initial: remoteFixture({ dsh: { ...dshLoginFixture, active: true, errorCode: undefined } }),
    cancelDsh: () => cancelled.promise,
  });
  const click = shell.element("dsh-cancel").click();
  assertEquals(shell.calls.cancelDsh, 1);
  assertEquals(shell.element("dsh-cancel").disabled, true);
  shell.setRemoteState(remoteFixture({
    dsh: { ...dshLoginFixture, errorCode: undefined, message: "DSH cancelled; SSH remains alive" },
  }));
  cancelled.resolve();
  await click;
  assertFalse(shell.element("dsh-cancel").disabled);
  assertEquals(shell.element("dsh-cancel").hidden, true);
  assertEquals(shell.element("reconnect-panel").hidden, true);
  assertEquals(shell.timerDelays, [500]);
  shell.setRemoteState(remoteFixture({ reconnect: reconnectFixture }));
  await shell.runTimer(500);
  assertFalse(shell.element("reconnect-panel").hidden);
  assertEquals(shell.calls.cancel, 0);
  assertEquals(shell.calls.connect, []);
  assertEquals(shell.calls.retryDsh, 0);
});

Deno.test("shell DSH token editor saves the matching profile and retries only DSH", async () => {
  const shell = await createShellHarness({ initial: remoteFixture({ dsh: dshLoginFixture }) });
  await shell.element("dsh-update-token").click();
  assertFalse(shell.element("editor").hidden);
  assertEquals(shell.element("editor-title").textContent, "更新 DSH Web token");
  assertEquals(shell.element("ssh-target").value, reconnectProfile.sshTarget);
  assertEquals(shell.element("server-name").value, reconnectProfile.name);
  assertEquals(shell.element("dsh-web-token").value, "");
  assertEquals(shell.element("dsh-web-token-prompt").textContent, dshLoginFixture.message);
  await shell.runTimer(0);
  await shell.runTimer(0);
  assertEquals(shell.focused, shell.element("dsh-web-token"));

  shell.element("dsh-web-token").value = "fake-replacement-token";
  await shell.element("server-form").dispatch("submit");
  assertEquals(shell.calls.savedProfiles, [{
    ...reconnectProfile,
    dshWebToken: "fake-replacement-token",
  }]);
  assertEquals(shell.calls.bootstrap, 2);
  assertEquals(shell.calls.retryDsh, 1);
  assertEquals(shell.calls.poll, 1);
  assertEquals(shell.calls.connect, []);
  assertEquals(shell.calls.cancel, 0);
  assertEquals(shell.calls.cancelDsh, 0);
  assertEquals(shell.element("editor").hidden, true);
  assertEquals(shell.timerDelays.filter((delay) => delay === 500), [500]);
});

for (
  const changed of [
    remoteFixture({ dsh: dshLoginFixture, remoteActive: false }),
    remoteFixture({ dsh: { ...dshLoginFixture, profileId: "other-profile" } }),
  ]
) {
  Deno.test(`shell token save does not retry an inactive or different DSH owner: ${changed.remoteActive}`, async () => {
    const shell = await createShellHarness({ initial: remoteFixture({ dsh: dshLoginFixture }) });
    await shell.element("dsh-update-token").click();
    shell.element("dsh-web-token").value = "fake-replacement-token";
    shell.setRemoteState(changed);
    await shell.element("server-form").dispatch("submit");
    assertEquals(shell.calls.savedProfiles.length, 1);
    assertEquals(shell.calls.retryDsh, 0);
    assertEquals(shell.calls.connect, []);
    assertEquals(shell.calls.cancel, 0);
    assertEquals(shell.calls.cancelDsh, 0);
  });
}

Deno.test("shell SSH retry has no token-editor behavior and reports only process failure", async () => {
  const shell = await createShellHarness({
    initial: remoteFixture({
      reconnect: { ...reconnectFixture, active: false },
      remoteActive: false,
    }),
    connect: () => Promise.reject(new Error("Unable to spawn SSH")),
  });
  assertFalse(shell.element("reconnect-now").textContent.includes("token"));
  await shell.element("reconnect-now").click();
  await setImmediate();
  assertEquals(shell.element("editor").hidden, true);
  assertEquals(shell.element("dsh-connection-panel").hidden, true);
  assertEquals(shell.element("connecting").hidden, true);
  assertEquals(shell.element("toast").textContent, "Unable to spawn SSH");
  assertEquals(shell.calls.connect, [reconnectProfile.id]);
  assertEquals(shell.calls.retryDsh, 0);
});

Deno.test("shell remote revision rejects a stale poll after explicit SSH cancellation", async () => {
  const pending = Promise.withResolvers<ShellRemoteState>();
  const shell = await createShellHarness({ poll: () => pending.promise });
  const polling = shell.runTimer(500);
  await shell.element("reconnect-cancel").click();
  const cancelledNotice = shell.element("notice").textContent;
  pending.resolve(remoteFixture({ reconnect: reconnectFixture, dsh: dshLoginFixture }));
  await polling;
  assertEquals(shell.element("reconnect-panel").hidden, true);
  assertEquals(shell.element("dsh-connection-panel").hidden, true);
  assertFalse(shell.element("notice").hidden);
  assertEquals(shell.element("notice").textContent, cancelledNotice);
  assertEquals(shell.timerDelays, []);
});

Deno.test("shell stale DSH poll cannot revive cancelled checking or replace current SSH supervision", async () => {
  const pending = Promise.withResolvers<ShellRemoteState>();
  const checking = remoteFixture({
    dsh: { ...dshLoginFixture, active: true, errorCode: undefined, message: "Old DSH check" },
  });
  const cancelled = remoteFixture({
    dsh: { ...dshLoginFixture, errorCode: undefined, message: "DSH cancelled" },
  });
  let polls = 0;
  const shell = await createShellHarness({
    initial: checking,
    poll: () => polls++ === 0 ? pending.promise : Promise.resolve(cancelled),
  });
  const polling = shell.runTimer(500);
  await shell.element("dsh-cancel").click();
  pending.resolve(checking);
  await polling;
  assertEquals(shell.element("dsh-connection-message").textContent, "DSH cancelled");
  assertEquals(shell.element("dsh-cancel").hidden, true);
  assertEquals(shell.element("reconnect-panel").hidden, true);
  assertEquals(shell.timerDelays, [500]);
  assertEquals(shell.calls.cancelDsh, 1);
  assertEquals(shell.calls.cancel, 0);
  assertEquals(shell.calls.connect, []);
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
