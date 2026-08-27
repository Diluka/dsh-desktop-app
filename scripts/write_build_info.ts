import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commit = Deno.env.get("GITHUB_SHA") ?? await resolveGitCommit();
if (!/^[0-9a-f]{40}$/iu.test(commit)) {
  throw new Error("Cannot determine a 40-character Git commit for this build");
}

await Deno.writeTextFile(
  join(root, "src", "build_info.ts"),
  `// Generated before packaging. Do not edit manually.\nexport const BUILD_COMMIT: string = "${commit.toLowerCase()}";\n`,
);

async function resolveGitCommit(): Promise<string> {
  const output = await new Deno.Command("git", {
    args: ["rev-parse", "HEAD"],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) throw new Error("git rev-parse HEAD failed");
  return new TextDecoder().decode(output.stdout).trim();
}
