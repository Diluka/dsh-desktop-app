import { assert, assertEquals, assertRejects } from "@std/assert";
import { startDesktop } from "../app.ts";
import type { ServerProfile } from "../src/profiles.ts";

// Exercise the real app, profile store, process lifecycle, SSH startup and HTTP
// probes. Only BrowserWindow and external executables are replaced. Each case
// runs in its own process: startDesktop owns global listeners and a pino file
// destination with no public close API. Isolation also prevents HOME/PATH mocks
// from affecting unrelated tests. No production-only test hooks are needed.
type Behavior = "ready" | "hold" | "network" | "auth" | "host-key" | "login";
type ReconnectState = { active: boolean; message: string; errorCode?: string } | null;
type Child = {
  pid: number;
  port: number;
  kind: string;
  target: string;
  behavior: Behavior;
  startedAt: number;
  requests: number;
};

class TestWindow extends EventTarget {
  readonly bindings = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  readonly navigations: { url: string; bindings: string[] }[] = [];
  closed = false;

  bind(name: string, callback: (...args: unknown[]) => Promise<unknown>): void {
    this.bindings.set(name, callback);
  }

  unbind(name: string): void {
    assert(this.bindings.delete(name), `Binding ${name} must exist before unbinding`);
  }

  async invoke<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    const callback = this.bindings.get(name);
    assert(callback, `Native callback ${name} must be bound`);
    const result = callback(...args);
    assert(result instanceof Promise, "Native handlers must return promises");
    return await result as T;
  }

  navigate(url: string): void {
    assert(!this.closed, "A closed window must never navigate");
    this.navigations.push({ url, bindings: [...this.bindings.keys()] });
  }

  setTitle(_title: string): void {}

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    const event = new Event("close", { cancelable: true });
    if (this.dispatchEvent(event)) this.closed = true;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 8_000) {
  const deadline = performance.now() + timeout;
  while (!(await check())) {
    assert(performance.now() < deadline, `Timed out: ${label}`);
    await sleep(15);
  }
}

function alive(pid: number): boolean {
  try {
    Deno.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function reapFixtureChildren(temp: string): Promise<void> {
  let ledger: string;
  try {
    ledger = await Deno.readTextFile(`${temp}/pids`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  for (const pid of ledger.trim().split("\n").map(Number)) {
    if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) Deno.kill(pid, "SIGKILL");
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Runs only in fixture children, with no package imports, user shell startup,
// real SSH, node, npm or dsh. A fake SSH process really binds its assigned -L
// port and forwards HTTP to the test's independent loopback server.
const FAKE_CHILD = String.raw`
const [kind, ...args] = Deno.args;
Deno.writeTextFileSync(Deno.env.get("APP_RECONNECT_PID_FILE"), String(Deno.pid) + "\n", { append: true });
if (kind === "ssh" && !args.includes("-N")) Deno.exit(1);
const forward = kind === "ssh" ? args[args.indexOf("-L") + 1].split(":") : undefined;
const port = Number(forward ? forward[1] : args[args.indexOf("--port") + 1]);
const upstream = Deno.env.get("APP_RECONNECT_UPSTREAM");
const registration = await fetch(upstream + "/register", {
  method: "POST",
  body: JSON.stringify({ pid: Deno.pid, port, kind, target: kind === "ssh" ? args.at(-1) : "local" }),
});
const { behavior } = await registration.json();
if (behavior === "network" || behavior === "auth" || behavior === "host-key") {
  console.error(behavior === "network" ? "Connection refused" :
    behavior === "auth" ? "Permission denied (publickey)" : "Host key verification failed");
  Deno.exit(255);
}
const server = Deno.serve({ hostname: "127.0.0.1", port, onListen() {} }, async (request) => {
  try {
    const response = await fetch(upstream + new URL(request.url).pathname, {
      headers: { "x-fixture-pid": String(Deno.pid) },
    });
    return new Response(await response.text(), { status: response.status });
  } catch {
    return new Response("Fixture upstream unavailable", { status: 503 });
  }
});
await server.finished;
`;

class AppFixture {
  readonly window = new TestWindow();
  readonly children: Child[] = [];
  readonly held: (() => void)[] = [];
  nextBehavior: Behavior = "ready";
  private server?: Deno.HttpServer<Deno.NetAddr>;
  constructor(private readonly temp: string) {}

  private readonly environment = new Map<string, string | undefined>();
  private readonly browserDescriptor = Object.getOwnPropertyDescriptor(Deno, "BrowserWindow");
  profile!: ServerProfile;
  other!: ServerProfile;

  async start(): Promise<void> {
    const deno = Deno.execPath();
    const bin = `${this.temp}/bin`;
    await Deno.mkdir(bin);
    await Deno.writeTextFile(`${this.temp}/child.ts`, FAKE_CHILD);
    this.server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
      if (new URL(request.url).pathname === "/register") {
        const registration = await request.json();
        const child: Child = {
          ...registration,
          behavior: this.nextBehavior,
          startedAt: performance.now(),
          requests: 0,
        };
        this.children.push(child);
        return Response.json({ behavior: child.behavior });
      }
      const child = this.children.find((entry) =>
        entry.pid === Number(request.headers.get("x-fixture-pid"))
      );
      assert(child, "Only registered fake children may contact the fixture server");
      child.requests++;
      if (child.behavior === "hold") await new Promise<void>((resolve) => this.held.push(resolve));
      return new Response("fixture DSH Web", { status: child.behavior === "login" ? 401 : 200 });
    });
    const launch = `exec ${
      quote(deno)
    } run --no-config --no-check --allow-net=127.0.0.1 --allow-env ${
      quote(`--allow-write=${this.temp}/pids`)
    } ${quote(`${this.temp}/child.ts`)}`;
    for (const tool of ["ssh", "dsh", "node", "npx"]) {
      const versionFlag = tool === "ssh" ? "-V" : "--version";
      const version = tool === "ssh" ? "OpenSSH_fixture" : "fixture-1.0.0";
      await this.executable(
        `${bin}/${tool}`,
        `#!/bin/sh\nif [ "$1" = "${versionFlag}" ]; then printf '%s\\n' '${version}'; exit 0; fi\n${
          tool === "ssh" || tool === "dsh" ? `${launch} ${tool} "$@"` : "exit 97"
        }\n`,
      );
    }
    // Retain real shell command/probe semantics, but never source /etc/profile,
    // .profile or a user's interactive shell configuration.
    await this.executable(
      `${bin}/shell`,
      '#!/bin/sh\n[ "$1" = "-lic" ] || exit 98\nshift\nexec /bin/sh -c "$@"\n',
    );
    for (
      const [name, value] of Object.entries({
        HOME: this.temp,
        USERPROFILE: this.temp,
        XDG_CONFIG_HOME: `${this.temp}/config`,
        XDG_STATE_HOME: `${this.temp}/state`,
        XDG_CACHE_HOME: `${this.temp}/cache`,
        APPDATA: `${this.temp}/config`,
        LOCALAPPDATA: `${this.temp}/state`,
        PATH: bin,
        SHELL: `${bin}/shell`,
        APP_RECONNECT_UPSTREAM: `http://127.0.0.1:${this.server.addr.port}`,
        APP_RECONNECT_PID_FILE: `${this.temp}/pids`,
      })
    ) {
      this.environment.set(name, Deno.env.get(name));
      Deno.env.set(name, value);
    }
    const window = this.window;
    Object.defineProperty(Deno, "BrowserWindow", {
      configurable: true,
      value: class {
        constructor() {
          return window;
        }
      },
    });
    await startDesktop("cef");
    const bootstrap = await window.invoke<
      { profiles: ServerProfile[]; localEnvironment: { canStart: boolean } }
    >("bootstrap");
    assertEquals(bootstrap.profiles, [], "Must not load the user's real profiles");
    assert(bootstrap.localEnvironment.canStart, "The isolated fake dsh must be discoverable");
    this.profile = await window.invoke<ServerProfile>("saveProfile", {
      name: "Fixture A",
      sshTarget: "fixture-a",
      remotePort: this.server.addr.port,
      dshWebToken: "synthetic-a",
    });
    this.other = await window.invoke<ServerProfile>("saveProfile", {
      name: "Fixture B",
      sshTarget: "fixture-b",
      remotePort: this.server.addr.port,
      dshWebToken: "synthetic-b",
    });
  }

  private async executable(path: string, content: string): Promise<void> {
    await Deno.writeTextFile(path, content);
    await Deno.chmod(path, 0o700);
  }

  async connect(): Promise<void> {
    await this.window.invoke("connectProfile", this.profile.id);
    assertEquals(this.children.length, 1);
    this.assertRemoteNavigation(0, this.children[0], "synthetic-a");
  }

  assertRemoteNavigation(index: number, child: Child, token: string): void {
    const navigation = this.window.navigations[index];
    assert(navigation, `Expected navigation ${index}`);
    const url = new URL(navigation.url);
    assertEquals(url.hostname, "127.0.0.1");
    assertEquals(url.port, String(child.port));
    assertEquals(url.searchParams.get("token"), token);
    assertEquals(navigation.bindings, [], "DSH Web must not inherit any native bindings");
    assert(child.requests > 0, "Navigation must follow a real successful HTTP probe");
  }

  async disconnect(): Promise<void> {
    Deno.kill(this.children[0].pid, "SIGKILL");
    await until(async () => {
      if (!this.window.bindings.has("getReconnectState")) return false;
      return (await this.state())?.active === true;
    }, "unexpected child exit returns to shell and schedules reconnect");
    assertEquals(this.window.navigations.length, 2);
    assert(this.window.navigations[1].bindings.includes("connectProfile"));
    const response = await fetch(this.window.navigations[1].url);
    assertEquals(response.status, 200, "Recovery navigates to the real local shell server");
    await response.body?.cancel();
  }

  state(): Promise<ReconnectState> {
    return this.window.invoke<ReconnectState>("getReconnectState");
  }

  async holdRetry(): Promise<Child> {
    this.nextBehavior = "hold";
    await this.disconnect();
    await until(
      () => this.children.length === 2 && this.children[1].requests > 0,
      "retry child has an in-flight real HTTP probe",
    );
    assert((await this.state())?.message.includes("正在重连"));
    return this.children[1];
  }

  release(): void {
    for (const resolve of this.held.splice(0)) resolve();
  }

  async assertCancelled(childCount = 1): Promise<void> {
    assertEquals(await this.state(), null);
    const navigationCount = this.window.navigations.length;
    this.release();
    // Cross the initial 1s retry deadline (including a late HTTP response).
    await sleep(1_200);
    assertEquals(this.children.length, childCount, "Cancellation must prevent any new child");
    assertEquals(
      this.window.navigations.length,
      navigationCount,
      "No late navigation after cancellation",
    );
    assertEquals(await this.state(), null);
    assert(
      this.children.every((child) => !alive(child.pid)),
      "All cancelled children must be reaped",
    );
  }

  async close(): Promise<void> {
    this.window.close();
    await until(() => this.window.closed, "shutdown closes the native window after cleanup");
    assert(
      this.children.every((child) => !alive(child.pid)),
      "Shutdown must reap all its children",
    );
  }

  async dispose(): Promise<void> {
    this.release();
    try {
      if (this.window.bindings.size || this.window.navigations.length) await this.close();
    } finally {
      // Even a failing assertion must not leave any registered fixture child.
      for (const child of this.children) {
        if (alive(child.pid)) Deno.kill(child.pid, "SIGKILL");
      }
      await until(() => this.children.every((child) => !alive(child.pid)), "fixture child cleanup");
      await this.server?.shutdown();
      if (this.browserDescriptor) {
        Object.defineProperty(Deno, "BrowserWindow", this.browserDescriptor);
      } else Reflect.deleteProperty(Deno, "BrowserWindow");
      for (const [name, value] of this.environment) {
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
    }
  }
}

const scenarios: Record<string, (fixture: AppFixture) => Promise<void>> = {
  "unexpected exit reconnects and removes native bindings before navigation": async (f) => {
    await f.connect();
    await f.disconnect();
    const state = await f.state();
    assert(state?.message.includes("1 秒后自动重连（1/5）"));
    const bootstrap = await f.window.invoke<{ reconnect: ReconnectState }>("bootstrap");
    assertEquals(bootstrap.reconnect, state);
    await until(() => f.window.navigations.length === 3, "successful automatic reconnect");
    assertEquals(f.children.length, 2);
    f.assertRemoteNavigation(2, f.children[1], "synthetic-a");
    assertEquals(f.window.bindings.size, 0);
  },
  "cancel while waiting prevents the scheduled retry": async (f) => {
    await f.connect();
    await f.disconnect();
    await f.window.invoke("cancelReconnect");
    await f.assertCancelled();
  },
  "cancel during startup reaps child and rejects late HTTP readiness": async (f) => {
    await f.connect();
    const retry = await f.holdRetry();
    await f.window.invoke("cancelReconnect");
    assert(!alive(retry.pid), "Cancel must await retry child cleanup");
    await f.assertCancelled(2);
  },
  "switching profile cancels in-flight retry without late navigation": async (f) => {
    await f.connect();
    const retry = await f.holdRetry();
    f.nextBehavior = "ready";
    await f.window.invoke("connectProfile", f.other.id);
    assert(!alive(retry.pid));
    assertEquals(f.children.length, 3);
    assertEquals(f.children[2].target, "fixture-b");
    f.assertRemoteNavigation(2, f.children[2], "synthetic-b");
    f.release();
    await sleep(1_200);
    assertEquals(f.children.length, 3);
    assertEquals(f.window.navigations.length, 3);
  },
  "selecting local mode cancels in-flight remote retry": async (f) => {
    await f.connect();
    await f.holdRetry();
    await f.window.invoke("setModePreference", "local");
    assertEquals((await f.window.invoke<{ mode: string }>("bootstrap")).mode, "local");
    await f.assertCancelled(2);
  },
  "starting local DSH cancels remote retry and cannot restore remote navigation": async (f) => {
    await f.connect();
    const retry = await f.holdRetry();
    f.nextBehavior = "ready";
    await f.window.invoke("connectLocal");
    assert(!alive(retry.pid));
    assertEquals(f.children.length, 3);
    assertEquals(f.children[2].kind, "dsh");
    const navigation = f.window.navigations[2];
    assertEquals(new URL(navigation.url).port, String(f.children[2].port));
    assertEquals(navigation.bindings, []);
    f.release();
    await sleep(1_200);
    assertEquals(f.children.length, 3);
    assertEquals(f.window.navigations.length, 3);
  },
  "shutdown of an active tunnel never starts recovery": async (f) => {
    await f.connect();
    await f.close();
    await sleep(1_200);
    assertEquals(f.children.length, 1);
    assertEquals(f.window.navigations.length, 1);
  },
  "shutdown while waiting prevents recovery": async (f) => {
    await f.connect();
    await f.disconnect();
    await f.close();
    await sleep(1_200);
    assertEquals(f.children.length, 1);
    assertEquals(f.window.navigations.length, 2);
  },
  "shutdown during retry startup rejects late readiness": async (f) => {
    await f.connect();
    await f.holdRetry();
    await f.close();
    f.release();
    await sleep(1_200);
    assertEquals(f.children.length, 2);
    assertEquals(f.window.navigations.length, 2);
  },
  "shutdown during manual startup cleans child without navigation": async (f) => {
    f.nextBehavior = "hold";
    const connecting = assertRejects(() => f.window.invoke("connectProfile", f.profile.id));
    await until(
      () => f.children.length === 1 && f.children[0].requests > 0,
      "manual startup HTTP probe",
    );
    await f.close();
    await connecting;
    f.release();
    await sleep(1_200);
    assertEquals(f.children.length, 1);
    assertEquals(f.window.navigations.length, 0);
  },
  "five real backoffs exhaust transient failures and leave manual retry": async (f) => {
    await f.connect();
    f.nextBehavior = "network";
    const disconnectedAt = performance.now();
    await f.disconnect();
    await until(async () => (await f.state())?.active === false, "five retries exhausted", 40_000);
    assertEquals(
      f.children.length,
      6,
      "Exactly five automatic attempts after the initial connection",
    );
    const delays = [1_000, 2_000, 4_000, 8_000, 15_000];
    for (let i = 0; i < delays.length; i++) {
      const previous = i === 0 ? disconnectedAt : f.children[i].startedAt;
      assert(
        f.children[i + 1].startedAt - previous >= delays[i] - 100,
        `Attempt ${i + 1} must respect its ${delays[i]}ms backoff`,
      );
    }
    assertEquals((await f.state())?.errorCode, "CONNECTION_FAILED");
    assert((await f.state())?.message.includes("手动重试"));
    await sleep(1_200);
    assertEquals(f.children.length, 6);
    assertEquals(f.window.navigations.length, 2);
    assert(f.children.every((child) => !alive(child.pid)));
    // Manual retry must remain usable after the automatic budget is exhausted.
    f.nextBehavior = "ready";
    await f.window.invoke("connectProfile", f.profile.id);
    f.assertRemoteNavigation(2, f.children[6], "synthetic-a");
  },
};

for (
  const [behavior, code] of [["auth", "AUTH_FAILED"], ["host-key", "HOST_KEY_FAILED"], [
    "login",
    "DSH_LOGIN_REQUIRED",
  ]] as const
) {
  scenarios[`restricted ${code} stops recovery for manual intervention`] = async (f) => {
    await f.connect();
    f.nextBehavior = behavior;
    await f.disconnect();
    await until(async () => (await f.state())?.active === false, "restricted error stops retries");
    assertEquals((await f.state())?.errorCode, code);
    assert((await f.state())?.message.includes("手动重试"));
    await sleep(2_200); // Cross the second-attempt deadline, not just the first.
    assertEquals(f.children.length, 2);
    assertEquals(f.window.navigations.length, 2);
    assert(f.children.every((child) => !alive(child.pid)));
  };
}

if (import.meta.main) {
  const scenario = scenarios[Deno.args[0]];
  assert(scenario, "Unknown app integration scenario");
  assert(Deno.args[1], "The test runner must supply an isolated temporary directory");
  const fixture = new AppFixture(Deno.args[1]);
  try {
    await fixture.start();
    await scenario(fixture);
  } finally {
    await fixture.dispose();
  }
} else {
  for (const name of Object.keys(scenarios)) {
    Deno.test({
      name: `startDesktop reconnect: ${name}`,
      ignore: Deno.build.os === "windows",
      async fn() {
        const temp = await Deno.makeTempDir({ prefix: "dsh-app-reconnect-" });
        const child = new Deno.Command(Deno.execPath(), {
          args: ["run", "--no-check", "--permission-set=app", import.meta.filename!, name, temp],
          cwd: new URL("../", import.meta.url),
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        const timeout = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch { /* Already exited. */ }
        }, 60_000);
        try {
          const output = await child.output();
          assert(
            output.success,
            `Isolated app scenario failed (${output.code}):\n${
              new TextDecoder().decode(output.stdout)
            }${new TextDecoder().decode(output.stderr)}`,
          );
        } finally {
          clearTimeout(timeout);
          await child.status;
          // A hard worker timeout bypasses its finally. The parent still owns
          // the temporary directory and PID ledger, including token-probe
          // children that have not reached the HTTP registration endpoint.
          try {
            await reapFixtureChildren(temp);
          } finally {
            await Deno.remove(temp, { recursive: true });
          }
        }
      },
    });
  }
}
