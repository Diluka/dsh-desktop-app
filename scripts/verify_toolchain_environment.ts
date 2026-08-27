import { isAbsolute, normalize } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runHiddenCommand } from "../src/hidden_process.ts";
import { probeLocalDshEnvironment } from "../src/local_dsh.ts";

const expectedPathFragment = Deno.env.get("EXPECTED_NODE_PATH_FRAGMENT");
const expectedLauncher = Deno.env.get("EXPECTED_LAUNCHER") ?? "npx";
if (!expectedPathFragment) throw new Error("EXPECTED_NODE_PATH_FRAGMENT is required");
if (expectedLauncher !== "dsh" && expectedLauncher !== "npx") {
  throw new Error("EXPECTED_LAUNCHER must be dsh or npx");
}

const calls: Array<{ command: string; args: string[] }> = [];
const environment = await probeLocalDshEnvironment(async (command, args) => {
  calls.push({ command, args });
  return await runHiddenCommand(command, args, 10_000);
});

assertEquals(calls.length, 1);
assertEquals(calls[0].command, Deno.env.get("SHELL"));
assertEquals(calls[0].args[0], "-lic");
for (const tool of ["node", "dsh", "npx"]) {
  assertStringIncludes(calls[0].args[1], `${tool} --version`);
}
assert(!calls[0].args[1].includes("@deepseek-ai/dsh"));
assert(environment.node, "login shell did not resolve Node.js");
assert(environment.npx, "login shell did not resolve npx");
assertEquals(environment.launcher?.kind, expectedLauncher);
assertEquals(environment.launcher?.command, Deno.env.get("SHELL"));
assertEquals(
  environment.launcher?.prefix,
  expectedLauncher === "dsh"
    ? ["-lic", 'exec "$0" "$@"', "dsh"]
    : ["-lic", 'exec "$0" "$@"', "npx", "-y", "@deepseek-ai/dsh"],
);
if (expectedLauncher === "dsh") {
  assert(environment.dsh, "login shell did not resolve the expected dsh command");
  assert(isAbsolute(environment.dsh.command));
  assertStringIncludes(
    normalize(environment.dsh.command).toLowerCase(),
    expectedPathFragment.toLowerCase(),
  );
} else {
  assertEquals(environment.dsh, undefined);
}
assert(isAbsolute(environment.node.command));
assert(isAbsolute(environment.npx.command));
assertStringIncludes(
  normalize(environment.node.command).toLowerCase(),
  expectedPathFragment.toLowerCase(),
);
assertStringIncludes(
  normalize(environment.npx.command).toLowerCase(),
  expectedPathFragment.toLowerCase(),
);

console.log(JSON.stringify(
  {
    os: Deno.build.os,
    shell: Deno.env.get("SHELL"),
    node: environment.node,
    dsh: environment.dsh,
    npx: environment.npx,
    launcher: environment.launcher,
  },
  null,
  2,
));
