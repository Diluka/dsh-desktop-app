import { assert, assertEquals } from "@std/assert";
import { startDesktop } from "../app.ts";
import type { ServerProfile } from "../src/profiles.ts";

// Real app/store/process supervision/HTTP, replacing only BrowserWindow and
// external executables. Each scenario has its own worker, HOME and PATH: app
// global listeners and the logger must never leak into another test or real HOME.
// Expectations below are lifecycle invariants, not a copy of app implementation.
type Behavior =
  | "ready"
  | "hold"
  | "offline"
  | "server-error"
  | "network"
  | "auth"
  | "host-key"
  | "login";
type LayerState = {
  profileId: string;
  profileName: string;
  active: boolean;
  message: string;
  errorCode?: string;
} | null;
type RemoteState = { reconnect: LayerState; dsh: LayerState; remoteActive: boolean };
type Child = {
  pid: number;
  port: number;
  kind: "ssh" | "token-probe" | "dsh";
  target: string;
  behavior: Behavior;
  startedAt: number;
  requests: number;
  tokens: (string | null)[];
};

class TestWindow extends EventTarget {
  readonly bindings = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  readonly navigations: { url: string; bindings: string[] }[] = [];
  closed = false;
  failRemoteNavigation = false;

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
    if (this.failRemoteNavigation && new URL(url).searchParams.has("token")) {
      this.failRemoteNavigation = false;
      throw new Error("Fixture browser navigation failed");
    }
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

// No real SSH, node/npm/dsh or login shell startup. Main SSH children really
// bind their -L port and forward HTTP to a separate loopback server. An offline
// service leaves its main process alive WITHOUT binding that port. Auxiliary
// SSH token probes have their own registration/PID and cannot masquerade as a
// main-process respawn. The parent PID ledger also covers pre-registration exits.
const FAKE_CHILD = String.raw`
const [tool, ...args] = Deno.args;
Deno.writeTextFileSync(Deno.env.get("APP_RECONNECT_PID_FILE"), String(Deno.pid) + "\n", { append: true });
const kind = tool === "ssh" && !args.includes("-N") ? "token-probe" : tool;
const forward = kind === "ssh" ? args[args.indexOf("-L") + 1].split(":") : undefined;
const port = kind === "token-probe" ? 0 : Number(forward ? forward[1] : args[args.indexOf("--port") + 1]);
const upstream = Deno.env.get("APP_RECONNECT_UPSTREAM");
const registration = await fetch(upstream + "/register", {
  method: "POST",
  body: JSON.stringify({ pid: Deno.pid, port, kind, target: kind === "ssh" ? args.at(-1) : kind }),
});
const { behavior, tokenProbe, recoveredToken } = await registration.json();
if (kind === "token-probe") {
  if (tokenProbe === "hold") await new Promise(() => setInterval(() => {}, 1000));
  if (recoveredToken) console.log("dsh web: http://127.0.0.1:3080/?token=" + recoveredToken);
  Deno.exit(recoveredToken ? 0 : 1);
}
if (behavior === "network" || behavior === "auth" || behavior === "host-key") {
  console.error(behavior === "network" ? "Connection refused" :
    behavior === "auth" ? "Permission denied (publickey)" : "Host key verification failed");
  Deno.exit(255);
}
if (behavior === "offline") await new Promise(() => setInterval(() => {}, 1000));
const server = Deno.serve({ hostname: "127.0.0.1", port, onListen() {} }, async (request) => {
  try {
    const url = new URL(request.url);
    const response = await fetch(upstream + url.pathname + url.search, {
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
  tokenProbe: "missing" | "hold" = "missing";
  recoveredToken?: string;
  acceptedToken?: string;
  private server?: Deno.HttpServer<Deno.NetAddr>;
  constructor(private readonly temp: string) {}

  private readonly environment = new Map<string, string | undefined>();
  private readonly browserDescriptor = Object.getOwnPropertyDescriptor(Deno, "BrowserWindow");
  profile!: ServerProfile;
  other!: ServerProfile;

  get mains(): Child[] {
    return this.children.filter((child) => child.kind === "ssh");
  }

  get probes(): Child[] {
    return this.children.filter((child) => child.kind === "token-probe");
  }

  get remoteNavigations() {
    return this.window.navigations.filter((navigation) =>
      new URL(navigation.url).searchParams.has("token")
    );
  }

  async start(): Promise<void> {
    const deno = Deno.execPath();
    const bin = `${this.temp}/bin`;
    await Deno.mkdir(bin);
    await Deno.writeTextFile(`${this.temp}/child.ts`, FAKE_CHILD);
    this.server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/register") {
        const registration = await request.json();
        const child: Child = {
          ...registration,
          behavior: this.nextBehavior,
          startedAt: performance.now(),
          requests: 0,
          tokens: [],
        };
        this.children.push(child);
        return Response.json({
          behavior: child.behavior,
          tokenProbe: this.tokenProbe,
          recoveredToken: this.recoveredToken,
        });
      }
      const child = this.children.find((entry) =>
        entry.pid === Number(request.headers.get("x-fixture-pid"))
      );
      assert(child, "Only registered fake children may contact the fixture server");
      child.requests++;
      child.tokens.push(url.searchParams.get("token"));
      // Capture status before holding: releasing an obsolete success must not
      // navigate after a cancel, profile switch, delete, close or process exit.
      const status = child.behavior === "server-error"
        ? 500
        : child.behavior === "login" && url.searchParams.get("token") !== this.acceptedToken
        ? 401
        : 200;
      if (child.behavior === "hold") await new Promise<void>((resolve) => this.held.push(resolve));
      return new Response("fixture DSH Web", { status });
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
      RemoteState & {
        profiles: ServerProfile[];
        localEnvironment: { canStart: boolean };
      }
    >("bootstrap");
    assertEquals(bootstrap.profiles, [], "Must not load the user's real profiles");
    assert(bootstrap.localEnvironment.canStart, "The isolated fake dsh must be discoverable");
    assertEquals(bootstrap.remoteActive, false);
    assertEquals(await this.state(), { reconnect: null, dsh: null, remoteActive: false });
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

  state(): Promise<RemoteState> {
    return this.window.invoke<RemoteState>("getRemoteConnectionState");
  }

  async connect(behavior: Behavior = "ready"): Promise<Child> {
    this.nextBehavior = behavior;
    const count = this.mains.length;
    // This must return while DSH is still pending (including held HTTP/token
    // probes). Waiting for HTTP readiness here is itself a contract violation.
    await this.window.invoke("connectProfile", this.profile.id);
    await until(() => this.mains.length === count + 1, "main SSH registration");
    const child = this.mains[count];
    if (behavior === "ready") await this.waitNavigation(child, "synthetic-a");
    else if (behavior !== "offline") await until(() => child.requests > 0, "real DSH HTTP probe");
    return child;
  }

  async waitNavigation(child: Child, token: string): Promise<void> {
    await until(() =>
      this.remoteNavigations.some((navigation) => {
        const url = new URL(navigation.url);
        return url.port === String(child.port) && url.searchParams.get("token") === token;
      }), "successful independent DSH navigation");
    const navigation = this.remoteNavigations.find((entry) =>
      new URL(entry.url).port === String(child.port)
    )!;
    const url = new URL(navigation.url);
    assertEquals(url.hostname, "127.0.0.1");
    assertEquals(url.searchParams.get("token"), token);
    assertEquals(navigation.bindings, [], "DSH Web must not inherit any native bindings");
    assert(
      child.tokens.includes(token),
      "Navigation must follow a real probe with the accepted token",
    );
  }

  async waitDshError(code: string): Promise<RemoteState> {
    await until(async () => (await this.state()).dsh?.errorCode === code, code, 27_000);
    const state = await this.state();
    assertEquals(state.dsh?.active, false);
    assertEquals(state.dsh?.profileId, this.profile.id);
    assertEquals(
      state.remoteActive,
      true,
      "A live SSH process keeps shell polling active after DSH failure",
    );
    assert(!state.reconnect?.active, "DSH failure must not schedule an SSH retry");
    assert(!state.reconnect?.errorCode?.startsWith("DSH_"), "DSH errors belong only to DSH state");
    const bootstrap = await this.window.invoke<RemoteState>("bootstrap");
    assertEquals(bootstrap.dsh, state.dsh);
    assertEquals(bootstrap.reconnect, state.reconnect);
    assertEquals(bootstrap.remoteActive, true);
    return state;
  }

  async assertMainRetained(child: Child, count = this.mains.length): Promise<void> {
    const navigations = this.window.navigations.length;
    await sleep(1_200); // Cross the first automatic retry deadline.
    assert(
      alive(child.pid),
      "DSH failure/cancellation/token edit must retain the original SSH PID",
    );
    assertEquals(
      this.mains.length,
      count,
      "No main SSH spawn without process exit or explicit new endpoint",
    );
    assertEquals(
      this.window.navigations.length,
      navigations,
      "No stale DSH completion may navigate",
    );
    assertEquals((await this.state()).remoteActive, true);
  }

  async killAndWaitForRestart(child: Child): Promise<Child> {
    const count = this.mains.length;
    const exitedAt = performance.now();
    Deno.kill(child.pid, "SIGKILL");
    await until(
      async () =>
        this.window.bindings.has("getRemoteConnectionState") &&
        (await this.state()).reconnect?.active === true,
      "unexpected exit is observed regardless of DSH state",
    );
    const state = await this.state();
    assert(!state.reconnect?.errorCode?.startsWith("DSH_"));
    assertEquals(state.remoteActive, true);
    const shell = this.window.navigations.at(-1)!;
    assert(shell.bindings.includes("connectProfile"));
    const response = await fetch(shell.url);
    assertEquals(response.status, 200, "Recovery must display the real local shell");
    await response.body?.cancel();
    await until(
      () => this.mains.length === count + 1,
      "main SSH restarts after actual exit",
      5_000,
    );
    const replacement = this.mains[count];
    assert(replacement.startedAt - exitedAt >= 900, "Fixed 1s delay prevents a busy spawn loop");
    return replacement;
  }

  release(): void {
    for (const resolve of this.held.splice(0)) resolve();
  }

  async assertStopped(): Promise<void> {
    const childCount = this.children.length;
    const navigationCount = this.window.navigations.length;
    assertEquals(await this.state(), { reconnect: null, dsh: null, remoteActive: false });
    this.release();
    await sleep(1_200);
    assertEquals(
      this.children.length,
      childCount,
      "Explicit stop must prevent all late child creation",
    );
    assertEquals(
      this.window.navigations.length,
      navigationCount,
      "Explicit stop rejects late HTTP success",
    );
    assert(
      this.children.every((child) => !alive(child.pid)),
      "Explicit stop reaps main and auxiliary children",
    );
  }

  async close(): Promise<void> {
    this.window.close();
    await until(() => this.window.closed, "shutdown closes the native window after cleanup");
    assert(this.children.every((child) => !alive(child.pid)), "Shutdown must reap all children");
  }

  async dispose(): Promise<void> {
    this.release();
    try {
      if (!this.window.closed && (this.window.bindings.size || this.window.navigations.length)) {
        await this.close();
      }
    } finally {
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
    const first = await f.connect();
    const retry = await f.killAndWaitForRestart(first);
    assertEquals(f.mains.length, 2);
    await f.waitNavigation(retry, "synthetic-a");
    assertEquals(f.remoteNavigations.length, 2);
    assertEquals(f.window.bindings.size, 0);
  },
  "401 with no recoverable token leaves SSH alive and independently supervises its exit": async (
    f,
  ) => {
    const first = await f.connect("login");
    await f.waitDshError("DSH_LOGIN_REQUIRED");
    assertEquals(f.probes.length, 1, "401 tries auxiliary token discovery once");
    assert(!alive(f.probes[0].pid), "Completed auxiliary probe must be reaped");
    await f.assertMainRetained(first, 1);
    assertEquals(f.remoteNavigations.length, 0);
    f.nextBehavior = "ready";
    const retry = await f.killAndWaitForRestart(first);
    await f.waitNavigation(retry, "synthetic-a");
  },
  "DSH page navigation failure retains SSH and retries on the original PID": async (f) => {
    f.window.failRemoteNavigation = true;
    await f.window.invoke("connectProfile", f.profile.id);
    await until(() => f.mains.length === 1, "main SSH before page failure");
    const first = f.mains[0];
    await f.waitDshError("DSH_UNAVAILABLE");
    await f.assertMainRetained(first, 1);
    await f.window.invoke("retryDshConnection");
    await f.waitNavigation(first, "synthetic-a");
    assertEquals(f.mains.length, 1);
    assert(alive(first.pid));
  },
  "SSH exit is observed during pending token discovery": async (f) => {
    f.tokenProbe = "hold";
    const first = await f.connect("login");
    await until(() => f.probes.length === 1, "pending token-discovery child");
    const probe = f.probes[0];
    assert(alive(probe.pid));
    assertEquals((await f.state()).dsh?.active, true);
    f.nextBehavior = "ready";
    const retry = await f.killAndWaitForRestart(first);
    assert(!alive(probe.pid), "Exit cancels and awaits auxiliary cleanup before replacement");
    await f.waitNavigation(retry, "synthetic-a");
  },
  "SSH exit during an in-flight HTTP check rejects its late success": async (f) => {
    const first = await f.connect("hold");
    assertEquals((await f.state()).dsh?.active, true);
    f.nextBehavior = "login";
    const retry = await f.killAndWaitForRestart(first);
    f.release();
    await f.waitDshError("DSH_LOGIN_REQUIRED");
    assertEquals(f.remoteNavigations.length, 0);
    await f.assertMainRetained(retry, 2);
  },
  "cancelling DSH HTTP check retains SSH and does not detach its exit observer": async (f) => {
    const first = await f.connect("hold");
    await f.window.invoke("cancelDshConnection");
    assert(!(await f.state()).dsh?.active);
    f.release();
    await f.assertMainRetained(first, 1);
    assertEquals(f.remoteNavigations.length, 0);
    f.nextBehavior = "ready";
    const retry = await f.killAndWaitForRestart(first);
    await f.waitNavigation(retry, "synthetic-a");
  },
  "cancelling DSH token discovery reaps only auxiliary SSH": async (f) => {
    f.tokenProbe = "hold";
    const first = await f.connect("login");
    await until(() => f.probes.length === 1, "auxiliary SSH discovery");
    await f.window.invoke("cancelDshConnection");
    assert(!alive(f.probes[0].pid), "Cancel DSH awaits its auxiliary SSH cleanup");
    await f.assertMainRetained(first, 1);
    f.nextBehavior = "ready";
    const retry = await f.killAndWaitForRestart(first);
    await f.waitNavigation(retry, "synthetic-a");
  },
  "token edit cancels pending token discovery without stopping the main SSH": async (f) => {
    f.tokenProbe = "hold";
    const first = await f.connect("login");
    await until(() => f.probes.length === 1, "pending discovery before token edit");
    f.acceptedToken = "synthetic-edited-during-probe";
    f.profile = await f.window.invoke<ServerProfile>("saveProfile", {
      ...f.profile,
      dshWebToken: f.acceptedToken,
    });
    assert(!alive(f.probes[0].pid), "Token edit must await obsolete auxiliary probe cleanup");
    await f.assertMainRetained(first, 1);
    await f.window.invoke("retryDshConnection");
    await f.waitNavigation(first, f.acceptedToken);
    assertEquals(f.mains.length, 1);
    assertEquals(f.probes.length, 1);
  },
  "confirmed automatic token recovery navigates and persists without replacing SSH": async (f) => {
    f.recoveredToken = "synthetic-recovered";
    f.acceptedToken = f.recoveredToken;
    const first = await f.connect("login");
    await f.waitNavigation(first, f.recoveredToken);
    assert(alive(first.pid));
    assertEquals(f.mains.length, 1);
    f.nextBehavior = "hold";
    const retry = await f.killAndWaitForRestart(first);
    await until(() => retry.requests > 0, "recovered token reused by replacement SSH's DSH check");
    const bootstrap = await f.window.invoke<{ profiles: ServerProfile[] }>("bootstrap");
    assertEquals(
      bootstrap.profiles.find((profile) => profile.id === f.profile.id)?.dshWebToken,
      f.recoveredToken,
    );
    retry.behavior = "ready";
    f.release();
    await f.waitNavigation(retry, f.recoveredToken);
  },
  "switching profile stops old SSH and rejects held DSH success": async (f) => {
    const first = await f.connect("hold");
    f.nextBehavior = "ready";
    await f.window.invoke("connectProfile", f.other.id);
    assert(!alive(first.pid), "Switch must await old main SSH cleanup");
    await until(() => f.mains.length === 2, "new profile SSH");
    assertEquals(f.mains[1].target, "fixture-b");
    await f.waitNavigation(f.mains[1], "synthetic-b");
    f.release();
    await sleep(1_200);
    assertEquals(f.mains.length, 2);
    assertEquals(f.remoteNavigations.length, 1, "Old profile cannot navigate after switch");
  },
  "deleting active profile cleans main and pending token-discovery SSH": async (f) => {
    f.tokenProbe = "hold";
    const first = await f.connect("login");
    await until(() => f.probes.length === 1, "token discovery before delete");
    assertEquals(await f.window.invoke("deleteProfile", f.profile.id), true);
    assert(!alive(first.pid));
    await f.assertStopped();
  },
  "editing an endpoint stops SSH and cancels held DSH work": async (f) => {
    const first = await f.connect("hold");
    f.profile = await f.window.invoke<ServerProfile>("saveProfile", {
      ...f.profile,
      sshTarget: "fixture-new",
    });
    assert(!alive(first.pid));
    await f.assertStopped();
    const replacement = await f.connect();
    assertEquals(replacement.target, "fixture-new");
  },
  "selecting local mode cleans remote SSH and held DSH work": async (f) => {
    await f.connect("hold");
    await f.window.invoke("setModePreference", "local");
    assertEquals((await f.window.invoke<{ mode: string }>("bootstrap")).mode, "local");
    await f.assertStopped();
  },
  "starting local DSH cleans remote SSH and cannot restore stale remote navigation": async (f) => {
    const first = await f.connect("hold");
    f.nextBehavior = "ready";
    await f.window.invoke("connectLocal");
    assert(!alive(first.pid));
    const local = f.children.find((child) => child.kind === "dsh");
    assert(local);
    const navigation = f.window.navigations.at(-1)!;
    assertEquals(new URL(navigation.url).port, String(local.port));
    assertEquals(navigation.bindings, []);
    const count = f.window.navigations.length;
    f.release();
    await sleep(1_200);
    assertEquals(f.mains.length, 1);
    assertEquals(f.window.navigations.length, count);
  },
  "explicit cancel while waiting prevents scheduled SSH retry": async (f) => {
    const first = await f.connect();
    Deno.kill(first.pid, "SIGKILL");
    await until(async () =>
      f.window.bindings.has("getRemoteConnectionState") &&
      (await f.state()).reconnect?.active === true, "scheduled retry");
    await f.window.invoke("cancelReconnect");
    await f.assertStopped();
    assertEquals(f.mains.length, 1);
  },
  "explicit remote cancel cleans both layers during held HTTP": async (f) => {
    await f.connect("hold");
    await f.window.invoke("cancelReconnect");
    await f.assertStopped();
  },
  "consecutive real exits each create one replacement after the same fixed delay": async (f) => {
    let current = await f.connect();
    for (let exit = 0; exit < 3; exit++) {
      const exitedAt = performance.now();
      current = await f.killAndWaitForRestart(current);
      assert(
        current.startedAt - exitedAt < 3_500,
        "Replacement delay stays fixed, not exponential",
      );
      await f.waitNavigation(current, "synthetic-a");
      assertEquals(f.mains.length, exit + 2, "One observed exit creates exactly one replacement");
    }
    await sleep(1_200);
    assert(alive(current.pid));
    assertEquals(f.mains.length, 4, "No more replacements while the current process stays alive");
  },
};

for (const behavior of ["server-error", "offline"] as const) {
  scenarios[
    `${behavior} DSH failure never restarts live SSH and cannot suppress later process exit`
  ] = async (f) => {
    const first = await f.connect(behavior);
    await f.waitDshError("DSH_UNAVAILABLE");
    if (behavior === "server-error") {
      assert(first.requests > 1, "500 must exercise independent bounded HTTP retries");
    } else {
      assertEquals(
        first.requests,
        0,
        "Offline fixture has no HTTP listener, not a synthetic status code",
      );
      let refused = false;
      try {
        const response = await fetch(`http://127.0.0.1:${first.port}/`);
        await response.body?.cancel();
      } catch {
        refused = true;
      }
      assert(refused, "The forwarded loopback port must really be unreachable");
    }
    assertEquals(f.probes.length, 0, "Service errors must not initiate token discovery");
    await f.assertMainRetained(first, 1);
    assertEquals(f.remoteNavigations.length, 0);
    f.nextBehavior = "ready";
    const retry = await f.killAndWaitForRestart(first);
    await f.waitNavigation(retry, "synthetic-a");
  };
}

for (const method of ["retryDshConnection", "connectProfile"] as const) {
  scenarios[`token edit then ${method} reuses the same live SSH PID`] = async (f) => {
    const first = await f.connect("login");
    await f.waitDshError("DSH_LOGIN_REQUIRED");
    f.acceptedToken = "synthetic-new";
    f.profile = await f.window.invoke<ServerProfile>("saveProfile", {
      ...f.profile,
      name: "Renamed fixture",
      dshWebToken: f.acceptedToken,
    });
    await f.assertMainRetained(first, 1);
    if (method === "connectProfile") await f.window.invoke(method, f.profile.id);
    else await f.window.invoke(method);
    await f.waitNavigation(first, f.acceptedToken);
    assert(alive(first.pid));
    assertEquals(
      f.mains.length,
      1,
      "Same profile/target/port must reuse SSH even when token/name changed",
    );
    assertEquals(f.probes.length, 1, "Valid new token needs no new discovery process");
    assert(first.tokens.includes("synthetic-a") && first.tokens.includes(f.acceptedToken));
  };
}

for (const behavior of ["network", "auth", "host-key"] as const) {
  scenarios[`${behavior} process exit follows the same one-replacement rule`] = async (f) => {
    const first = await f.connect();
    f.nextBehavior = behavior;
    const failed = await f.killAndWaitForRestart(first);
    f.nextBehavior = "ready";
    await until(
      () => f.mains.length === 3,
      "Actual SSH error exit still creates one replacement",
      5_000,
    );
    const replacement = f.mains[2];
    assert(
      !alive(failed.pid),
      "Replacement follows an actual exit, not stderr inspection of an alive process",
    );
    assert(replacement.startedAt - failed.startedAt >= 900, "Error exits also wait the fixed 1s");
    await f.waitNavigation(replacement, "synthetic-a");
    await sleep(1_200);
    assertEquals(f.mains.length, 3);
    assert(alive(replacement.pid));
  };
}

for (const phase of ["ready", "hold", "token-probe", "backoff"] as const) {
  scenarios[`shutdown during ${phase} cleans both layers and never starts recovery`] = async (
    f,
  ) => {
    if (phase === "token-probe") f.tokenProbe = "hold";
    const first = await f.connect(
      phase === "token-probe" ? "login" : phase === "backoff" ? "ready" : phase,
    );
    if (phase === "token-probe") {
      await until(() => f.probes.length === 1, "token discovery before close");
    }
    if (phase === "backoff") {
      Deno.kill(first.pid, "SIGKILL");
      await until(async () =>
        f.window.bindings.has("getRemoteConnectionState") &&
        (await f.state()).reconnect?.active === true, "SSH backoff before close");
    }
    await f.close();
    const childCount = f.children.length;
    const navigationCount = f.window.navigations.length;
    f.release();
    await sleep(1_200);
    assertEquals(f.children.length, childCount);
    assertEquals(f.window.navigations.length, navigationCount);
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
        }, 75_000);
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
          // A worker timeout bypasses its finally. The parent still owns the
          // directory and ledger, including not-yet-registered token probes.
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
