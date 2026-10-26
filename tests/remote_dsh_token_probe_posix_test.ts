import { assertEquals, assertFalse } from "@std/assert";
import { join } from "node:path";
import {
  extractRemoteDshWebTokenCandidates,
  recoverRemoteDshWebToken,
} from "../src/remote_dsh_token_probe.ts";
import POSIX_REMOTE_DSH_TOKEN_PROBE_SCRIPT from "../src/remote_dsh_token_probe_posix.sh" with {
  type: "text",
};
import { profile } from "./test_helpers.ts";

// Isolate the remote filesystem/process boundary. The real shell program runs,
// but it must never read this developer's actual /proc, tmp logs, tmux or journal.
async function withProbeFixture(fn: (fixture: ProbeFixture) => Promise<void>) {
  const root = await Deno.makeTempDir({ prefix: "dsh-token-probe-" });
  const proc = join(root, "proc");
  const tmp = join(root, "system-tmp");
  const bin = join(root, "bin");
  try {
    for (const directory of [proc, tmp, bin]) await Deno.mkdir(directory);
    for (const command of ["tmux", "journalctl"]) {
      const path = join(bin, command);
      await Deno.writeTextFile(path, "#!/bin/sh\nexit 0\n");
      await Deno.chmod(path, 0o700);
    }
    await fn({
      root,
      proc,
      tmp,
      async run(env = {}) {
        const child = new Deno.Command("sh", {
          args: ["-s"],
          cwd: root,
          env: {
            PATH: `${bin}:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}`,
            TMPDIR: "",
            TMP: "",
            TEMP: "",
            ...env,
          },
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        const script = POSIX_REMOTE_DSH_TOKEN_PROBE_SCRIPT
          .replaceAll("/tmp", tmp)
          .replaceAll("/proc", proc);
        await new Blob([script]).stream().pipeTo(child.stdin);
        const output = await child.output();
        assertEquals(output.success, true, new TextDecoder().decode(output.stderr));
        return {
          success: output.success,
          stdout: new TextDecoder().decode(output.stdout),
          stderr: new TextDecoder().decode(output.stderr),
        };
      },
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

interface ProbeFixture {
  root: string;
  proc: string;
  tmp: string;
  run(env?: Record<string, string>): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
  }>;
}

function launchLine(token: string) {
  return `dsh web: http://127.0.0.1:3080/?token=${token}\n`;
}

Deno.test({
  name: "POSIX probe discovers both plugins' detached restart logs without procfs",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withProbeFixture(async ({ root, proc, tmp, run }) => {
      // Neither plugin's replacement needs to remain a child of the SSH session.
      await Deno.remove(proc);
      const customTmp = join(root, "custom tmp");
      await Deno.mkdir(customTmp);
      await Deno.writeTextFile(
        join(customTmp, "dsh-simple-restart-2026-10-26T01-00-00.out.log"),
        launchLine("simple-token"),
      );
      await Deno.writeTextFile(
        join(tmp, "dsh-market-restart-2026-10-26T02-00-00.out.log"),
        launchLine("market-token"),
      );
      const { stdout } = await run({ TMPDIR: customTmp });
      const candidates = extractRemoteDshWebTokenCandidates(stdout);
      assertEquals(candidates.map(({ token }) => token).sort(), ["market-token", "simple-token"]);
      assertEquals(candidates.map(({ sourceId }) => sourceId), [
        "plugin-restart-log",
        "plugin-restart-log",
      ]);
    });
  },
});

Deno.test({
  name: "POSIX restart log probe follows Node tmpdir environment precedence",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withProbeFixture(async ({ root, run }) => {
      const directories = ["TMPDIR", "TMP", "TEMP"];
      const env: Record<string, string> = {};
      for (const name of directories) {
        env[name] = join(root, name);
        await Deno.mkdir(env[name]);
        await Deno.writeTextFile(
          join(env[name], "dsh-simple-restart-2026-10-26T01-00-00.out.log"),
          launchLine(name),
        );
      }
      for (const name of directories) {
        const { stdout } = await run(env);
        assertEquals(extractRemoteDshWebTokenCandidates(stdout).map(({ token }) => token), [name]);
        env[name] = "";
      }
    });
  },
});

Deno.test({
  name: "POSIX restart log probe keeps bounded head and tail of noisy logs",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withProbeFixture(async ({ tmp, run }) => {
      await Deno.writeTextFile(
        join(tmp, "dsh-market-restart-2026-10-26T01-00-00.out.log"),
        launchLine("boot-token") + "noisy output\n".repeat(20_000) + launchLine("latest-token"),
      );
      const { stdout } = await run();
      assertEquals(extractRemoteDshWebTokenCandidates(stdout).map(({ token }) => token), [
        "boot-token",
        "latest-token",
      ]);
      assertEquals(stdout.length < 132_000, true);
    });
  },
});

Deno.test({
  name: "POSIX restart log probe ignores unrelated files, symlinks and FIFOs",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withProbeFixture(async ({ root, tmp, run }) => {
      const unrelated = join(root, "unrelated.log");
      await Deno.writeTextFile(unrelated, launchLine("unrelated-token"));
      await Deno.writeTextFile(join(tmp, "other-service.out.log"), launchLine("other-token"));
      await Deno.writeTextFile(
        join(tmp, "dsh-market-restart-2026-10-26T01-00-00.recovery.json"),
        launchLine("not-a-log-token"),
      );
      await Deno.symlink(
        unrelated,
        join(tmp, "dsh-simple-restart-2026-10-26T01-00-00.out.log"),
      );
      const fifo = await new Deno.Command("mkfifo", {
        args: [join(tmp, "dsh-market-restart-2026-10-26T01-00-00.out.log")],
      }).output();
      assertEquals(fifo.success, true);
      assertEquals(extractRemoteDshWebTokenCandidates((await run()).stdout), []);
    });
  },
});

Deno.test({
  name: "POSIX restart log probe refuses files owned by another SSH user",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withProbeFixture(async ({ root, tmp, run }) => {
      await Deno.writeTextFile(
        join(tmp, "dsh-simple-restart-2026-10-26T01-00-00.out.log"),
        launchLine("other-user-token"),
      );
      // Change only the external identity command, not the ownership guard.
      const id = join(root, "bin", "id");
      const owner = (await Deno.stat(tmp)).uid;
      await Deno.writeTextFile(id, `#!/bin/sh\nprintf '%s\\n' '${owner === 0 ? 1 : 0}'\n`);
      await Deno.chmod(id, 0o700);
      assertEquals(extractRemoteDshWebTokenCandidates((await run()).stdout), []);
    });
  },
});

Deno.test({
  name: "POSIX restart log probe limits discovery to the 20 newest logs per directory",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withProbeFixture(async ({ tmp, run }) => {
      for (let i = 0; i < 25; i++) {
        const file = join(tmp, `dsh-market-restart-${i}.out.log`);
        await Deno.writeTextFile(file, launchLine(`token-${i}`));
        await Deno.utime(file, 1_700_000_000 + i, 1_700_000_000 + i);
      }
      const { stdout } = await run();
      const candidates = extractRemoteDshWebTokenCandidates(stdout);
      assertEquals(candidates.length, 20);
      assertEquals(candidates[0].token, "token-24");
      assertEquals(candidates.at(-1)?.token, "token-5");
    });
  },
});

Deno.test({
  name: "POSIX restart log probe filters non-files before applying the discovery limit",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withProbeFixture(async ({ tmp, run }) => {
      const log = join(tmp, "dsh-simple-restart-actual.out.log");
      await Deno.writeTextFile(log, launchLine("actual-token"));
      await Deno.utime(log, 1_700_000_000, 1_700_000_000);
      for (let i = 0; i < 25; i++) {
        const directory = join(tmp, `dsh-market-restart-directory-${i}.out.log`);
        await Deno.mkdir(directory);
        await Deno.utime(directory, 1_700_000_001 + i, 1_700_000_001 + i);
      }
      assertEquals(
        extractRemoteDshWebTokenCandidates((await run()).stdout).map(({ token }) => token),
        ["actual-token"],
      );
    });
  },
});

Deno.test({
  name: "POSIX proc probe reads detached CLI logs outside the SSH temp directory",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withProbeFixture(async ({ root, proc, run }) => {
      const entries = [
        ["/opt/bin/dsh", "web"],
        ["/opt/bin/dsh", "--profile", "custom", "web"],
        ["/opt/node_modules/@deepseek-ai/dsh/lib/bin.js", "web"],
        ["/opt/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js", "web"],
        ["/checkout/apps/cli/src/bin.ts", "web"],
        ["/opt/unrelated/bin.js", "web"],
      ];
      for (const [index, args] of entries.entries()) {
        const process = join(proc, String(1000 + index));
        await Deno.mkdir(join(process, "fd"), { recursive: true });
        await Deno.writeTextFile(join(process, "cmdline"), ["node", ...args, ""].join("\0"));
        const log = join(root, `detached-${index}.log`);
        await Deno.writeTextFile(log, launchLine(`entry-${index}`) + "output\n".repeat(3000));
        await Deno.symlink(log, join(process, "fd", "1"));
        await Deno.symlink("/dev/null", join(process, "fd", "2"));
      }
      // Unlike shared tmp discovery, the existing proc-fd source can point to
      // readable service logs not owned by the SSH user. Keep that behavior.
      const owner = (await Deno.stat(root)).uid;
      const id = join(root, "bin", "id");
      await Deno.writeTextFile(id, `#!/bin/sh\nprintf '%s\\n' '${owner === 0 ? 1 : 0}'\n`);
      await Deno.chmod(id, 0o700);
      const { stdout } = await run();
      const candidates = extractRemoteDshWebTokenCandidates(stdout);
      assertEquals(candidates.map(({ token }) => token).sort(), [
        "entry-0",
        "entry-1",
        "entry-2",
        "entry-3",
        "entry-4",
      ]);
      assertEquals(candidates.every(({ sourceId }) => sourceId === "proc-fd-log"), true);
      assertFalse(stdout.includes("entry-5"));
    });
  },
});

Deno.test({
  name: "recovery validates plugin restart candidates through the current tunnel before accepting",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withProbeFixture(async ({ tmp, run }) => {
      await Deno.writeTextFile(
        join(tmp, "dsh-simple-restart-2026-10-26T01-00-00.out.log"),
        launchLine("stale-token") + launchLine("current-token"),
      );
      const output = await run();
      const probed: string[] = [];
      const recovered = await recoverRemoteDshWebToken(profile(), 41011, {
        run: () => Promise.resolve(output),
        probe: (url) => {
          probed.push(url);
          return Promise.resolve(url.endsWith("token=current-token") ? 303 : 401);
        },
      });
      assertEquals(probed, [
        "http://127.0.0.1:41011/?token=stale-token",
        "http://127.0.0.1:41011/?token=current-token",
      ]);
      assertEquals(recovered?.token, "current-token");
      assertEquals(recovered?.sourceId, "plugin-restart-log");
    });
  },
});
