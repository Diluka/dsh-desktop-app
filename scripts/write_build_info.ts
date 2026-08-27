import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = Deno.env.get("GITHUB_SHA");
const commit = sha && /^[0-9a-f]{40}$/iu.test(sha) ? sha.toLowerCase() : "development";

// CI sets GITHUB_SHA, so packaged builds embed the release commit. Local builds
// keep the committed "development" value and therefore never check for updates.
await Deno.writeTextFile(
  join(root, "src", "build_info.ts"),
  `// Generated before packaging. Do not edit manually.\nexport const BUILD_COMMIT: string = "${commit}";\n`,
);
