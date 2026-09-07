import { assertEquals, assertFalse, assertRejects, assertStringIncludes } from "@std/assert";
import { type HiddenCommandOptions, runHiddenCommand } from "../src/hidden_process.ts";
import {
  buildRemoteTokenProbeSshArguments,
  collectRemoteDshWebTokenCandidates,
  extractRemoteDshWebTokenCandidates,
  posixRemoteDshTokenProbeProgram,
  recoverRemoteDshWebToken,
  type RemoteDshTokenProbeProgram,
} from "../src/remote_dsh_token_probe.ts";
import POSIX_REMOTE_DSH_TOKEN_PROBE_SCRIPT from "../src/remote_dsh_token_probe_posix.sh" with {
  type: "text",
};
import { profile } from "./test_helpers.ts";

Deno.test("buildRemoteTokenProbeSshArguments runs a non-interactive remote command", () => {
  const args = buildRemoteTokenProbeSshArguments(
    { ...profile(), dshWebToken: "saved-token" },
    ["sh", "-s"],
  );

  assertEquals(args, [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=12",
    "--",
    "prod-dsh",
    "sh",
    "-s",
  ]);
  assertFalse(args.includes("saved-token"));
});

Deno.test("posixRemoteDshTokenProbeProgram imports the maintained shell script", () => {
  const program = posixRemoteDshTokenProbeProgram();

  assertEquals(program.id, "posix-sh");
  assertEquals(program.args(profile()).at(-2), "sh");
  assertEquals(program.args(profile()).at(-1), "-s");
  assertEquals(program.stdin, POSIX_REMOTE_DSH_TOKEN_PROBE_SCRIPT);
  assertStringIncludes(program.stdin ?? "", "dsh_desktop_probe_tmux");
  assertStringIncludes(program.stdin ?? "", "journalctl-user");
  assertStringIncludes(program.stdin ?? "", "proc-fd-log");
});

Deno.test("posixRemoteDshTokenProbeProgram accepts a script override for tests", () => {
  assertEquals(posixRemoteDshTokenProbeProgram("custom script").stdin, "custom script");
});

Deno.test("POSIX remote token probe script passes sh syntax check", async () => {
  if (Deno.build.os === "windows") return;

  const output = await runHiddenCommand("sh", ["-n"], {
    stdin: POSIX_REMOTE_DSH_TOKEN_PROBE_SCRIPT,
  });

  assertEquals(output.success, true, output.stderr || output.stdout);
});

// This contract also runs on Windows and hosts without tmux.
Deno.test("POSIX remote token probe joins wrapped tmux lines before extracting tokens", () => {
  assertStringIncludes(
    POSIX_REMOTE_DSH_TOKEN_PROBE_SCRIPT,
    'tmux capture-pane -p -J -S -2000 -t "$pane"',
  );
});

const hasTmux = Deno.build.os !== "windows" &&
  (await runHiddenCommand("sh", ["-c", "command -v tmux >/dev/null 2>&1"])).success;

Deno.test({
  name: "POSIX shell/tmux integration preserves a 43-character token across column 80",
  ignore: !hasTmux,
  async fn() {
    const token = "a".repeat(42) + "Z"; // Synthetic; never use a real launch token.
    const url = `http://127.0.0.1:3080/?token=${token}`;
    const launchLine = `dsh web: ${url}`;
    assertEquals(launchLine.length, 81);

    // Every tmux invocation targets this test's server, including cleanup. Ignore
    // user tmux configuration and never list/capture panes on the default socket.
    const socket = `dsh-token-test-${crypto.randomUUID()}`;
    const tmux = (...args: string[]) =>
      runHiddenCommand("tmux", ["-L", socket, "-f", "/dev/null", ...args], {
        timeoutMilliseconds: 5_000,
      });
    try {
      const started = await tmux(
        "new-session",
        "-d",
        "-s",
        "token-probe",
        "-x",
        "80",
        "-y",
        "24",
        "sh",
        "-c",
        `printf '%s\\n' '${launchLine}' 'unrelated next line'; ` +
          `tmux -L '${socket}' -f /dev/null wait-for -S ready; ` +
          `exec tmux -L '${socket}' -f /dev/null wait-for hold`,
      );
      assertEquals(started.success, true, started.stderr);
      const ready = await tmux("wait-for", "ready");
      assertEquals(ready.success, true, ready.stderr);
      const width = await tmux("display-message", "-p", "-t", "token-probe:0.0", "#{pane_width}");
      assertEquals(width.stdout.trim(), "80");

      // Negative control reproduces the original truncation with the real tmux.
      const wrapped = await tmux("capture-pane", "-p", "-S", "-2000", "-t", "token-probe:0.0");
      assertEquals(wrapped.success, true, wrapped.stderr);
      assertStringIncludes(wrapped.stdout, `${launchLine.slice(0, 80)}\nZ\n`);
      assertEquals(extractRemoteDshWebTokenCandidates(wrapped.stdout, "tmux"), [{
        sourceId: "tmux",
        token: token.slice(0, 42),
        url: url.slice(0, -1),
      }]);

      // Load the maintained function definitions, but invoke only tmux: this test
      // must not read the host's journal or /proc logs, or contact any SSH host.
      const sections = POSIX_REMOTE_DSH_TOKEN_PROBE_SCRIPT.split(
        "\ndsh_desktop_probe_source tmux\n",
      );
      assertEquals(sections.length, 2);
      const joined = await runHiddenCommand("sh", ["-s"], {
        timeoutMilliseconds: 5_000,
        stdin: `${sections[0]}
tmux() { command tmux -L '${socket}' -f /dev/null "$@"; }
dsh_desktop_probe_source tmux
dsh_desktop_probe_tmux
`,
      });
      assertEquals(joined.success, true, joined.stderr);
      assertStringIncludes(joined.stdout, `${launchLine}\nunrelated next line\n`);
      assertEquals(extractRemoteDshWebTokenCandidates(joined.stdout), [{
        sourceId: "tmux",
        token,
        url,
      }]);
    } finally {
      const stopped = await tmux("kill-server");
      assertEquals(stopped.success, true, stopped.stderr);
    }
  },
});

Deno.test("extractRemoteDshWebTokenCandidates preserves source metadata", () => {
  const candidates = extractRemoteDshWebTokenCandidates(
    "dsh web: http://127.0.0.1:3080/?token=from-tmux\n",
    "tmux",
  );

  assertEquals(candidates, [{
    sourceId: "tmux",
    token: "from-tmux",
    url: "http://127.0.0.1:3080/?token=from-tmux",
  }]);
});

Deno.test("collectRemoteDshWebTokenCandidates executes probe programs through ssh", async () => {
  const calls: Array<{ command: string; args: string[]; options: HiddenCommandOptions }> = [];
  const programs: RemoteDshTokenProbeProgram[] = [{
    id: "fixture-program",
    args: (remoteProfile) => buildRemoteTokenProbeSshArguments(remoteProfile, ["sh", "-s"]),
    stdin: "probe script",
  }];

  const candidates = await collectRemoteDshWebTokenCandidates(profile(), {
    command: "fake-ssh",
    programs,
    run: (command, args, options) => {
      calls.push({ command, args, options });
      return Promise.resolve({
        success: true,
        stdout: "dsh web: http://127.0.0.1:3080/?token=auto-token\n",
        stderr: "",
      });
    },
  });

  assertEquals(calls.length, 1);
  assertEquals(calls[0].command, "fake-ssh");
  assertEquals(calls[0].args.at(-3), "prod-dsh");
  assertEquals(calls[0].options.stdin, "probe script");
  assertEquals(candidates, [{
    sourceId: "fixture-program",
    token: "auto-token",
    url: "http://127.0.0.1:3080/?token=auto-token",
  }]);
});

Deno.test("recoverRemoteDshWebToken returns the first candidate verified through the active tunnel", async () => {
  const probedUrls: string[] = [];
  const programs: RemoteDshTokenProbeProgram[] = [{
    id: "fixture-program",
    args: () => ["--", "prod-dsh", "sh", "-s"],
    stdin: "probe script",
  }];

  const recovered = await recoverRemoteDshWebToken(profile(), 41011, {
    programs,
    run: () =>
      Promise.resolve({
        success: true,
        stdout: [
          "dsh web: http://127.0.0.1:3080/?token=old-token",
          "dsh web: http://127.0.0.1:3080/?token=new-token",
        ].join("\n"),
        stderr: "",
      }),
    probe: (url) => {
      probedUrls.push(url);
      return Promise.resolve(url.includes("new-token") ? 302 : 401);
    },
  });

  assertEquals(probedUrls, [
    "http://127.0.0.1:41011/?token=old-token",
    "http://127.0.0.1:41011/?token=new-token",
  ]);
  assertEquals(recovered, {
    sourceId: "fixture-program",
    token: "new-token",
    url: "http://127.0.0.1:3080/?token=new-token",
  });
});

Deno.test("remote token recovery pre-cancellation starts no program or HTTP probe", async () => {
  const controller = new AbortController();
  controller.abort(new Error("custom reason"));
  let calls = 0;
  const error = await assertRejects(() =>
    recoverRemoteDshWebToken(profile(), 41000, {
      signal: controller.signal,
      run: () => {
        calls++;
        throw new Error("must not run");
      },
      probe: () => {
        calls++;
        throw new Error("must not probe");
      },
    }), DOMException);
  assertEquals(error.name, "AbortError");
  assertEquals(calls, 0);
});

for (const outcome of ["success", "error", "abort-error"] as const) {
  Deno.test(`remote token collection stops after cancellation with ${outcome}`, async () => {
    const controller = new AbortController();
    let runs = 0;
    let probes = 0;
    const error = await assertRejects(() =>
      recoverRemoteDshWebToken(profile(), 41000, {
        signal: controller.signal,
        programs: [{ id: "first", args: () => [] }, { id: "second", args: () => [] }],
        run: (_command, _args, options) => {
          runs++;
          assertEquals(options.signal, controller.signal);
          if (outcome === "abort-error") throw new DOMException("cancelled", "AbortError");
          controller.abort(new Error("cancel"));
          if (outcome === "error") throw new Error("interrupted");
          return Promise.resolve({
            success: true,
            stdout: "dsh web: http://127.0.0.1:3080/?token=late",
            stderr: "",
          });
        },
        probe: () => {
          probes++;
          return Promise.resolve(200);
        },
      }), DOMException);
    assertEquals(error.name, "AbortError");
    assertEquals(runs, 1);
    assertEquals(probes, 0);
  });
}

Deno.test("remote token recovery aborts an active candidate HTTP request without probing the next", async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let requests = 0;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async () => {
    requests++;
    entered.resolve();
    await release.promise;
    return new Response("done");
  });
  const result = recoverRemoteDshWebToken(profile(), server.addr.port, {
    signal: controller.signal,
    run: () =>
      Promise.resolve({
        success: true,
        stdout:
          "dsh web: http://127.0.0.1:3080/?token=first\ndsh web: http://127.0.0.1:3080/?token=second",
        stderr: "",
      }),
  });
  try {
    const rejected = assertRejects(() => result, DOMException);
    await entered.promise;
    controller.abort();
    assertEquals((await rejected).name, "AbortError");
    assertEquals(requests, 1);
  } finally {
    controller.abort();
    release.resolve();
    await result.catch(() => undefined);
    await server.shutdown();
  }
});

Deno.test("recoverRemoteDshWebToken returns undefined when no candidate verifies", async () => {
  const recovered = await recoverRemoteDshWebToken(profile(), 41012, {
    programs: [{ id: "fixture-program", args: () => [], stdin: "" }],
    run: () =>
      Promise.resolve({
        success: true,
        stdout: "dsh web: http://127.0.0.1:3080/?token=stale-token\n",
        stderr: "",
      }),
    probe: () => Promise.resolve(401),
  });

  assertEquals(recovered, undefined);
});
