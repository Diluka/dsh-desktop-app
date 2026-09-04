import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
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
