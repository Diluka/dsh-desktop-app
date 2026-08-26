import { cp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ResEdit from "resedit";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDirectory = join(root, "dist", "windows", "DSH-Desktop");
const executable = join(appDirectory, "DSH-Desktop.exe");
const icon = join(root, "assets", "icon.ico");
const packageRequested = Deno.args.length === 1 && Deno.args[0] === "--package";
if (Deno.args.length && !packageRequested) throw new Error("Expected only --package");

await runDesktop(appDirectory);
await embedIcon(executable, icon);

if (packageRequested) {
  const laufeyDevDirectory = await Deno.makeTempDir({ prefix: "dsh-laufey-" });
  try {
    const releaseDirectory = join(laufeyDevDirectory, "cef", "build", "Release");
    await cp(appDirectory, releaseDirectory, { recursive: true });
    const launcherName = Deno.build.os === "windows" ? "laufey.exe" : "laufey";
    await Deno.rename(
      join(releaseDirectory, "DSH-Desktop.exe"),
      join(releaseDirectory, launcherName),
    );
    await removeIfExists(join(releaseDirectory, "DSH-Desktop.dll"));
    await removeIfExists(join(releaseDirectory, ".deno-desktop-app"));
    await removeIfExists(join(releaseDirectory, "AppIcon.ico"));
    await runDesktop(join(root, "dist", "windows", "DSH-Desktop.msi"), {
      LAUFEY_DEV_DIR: laufeyDevDirectory,
    });
  } finally {
    await Deno.remove(laufeyDevDirectory, { recursive: true });
  }
}

async function runDesktop(output: string, env: Record<string, string> = {}): Promise<void> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "desktop",
      "--backend",
      "cef",
      "--permission-set=app",
      "--target",
      "x86_64-pc-windows-msvc",
      "--icon",
      icon,
      "--output",
      output,
      "--exclude-unused-npm",
      "main.ts",
    ],
    cwd: root,
    env,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await command.spawn().status;
  if (!status.success) throw new Error(`deno desktop failed with exit code ${status.code}`);
}

async function embedIcon(executablePath: string, iconPath: string): Promise<void> {
  const pe = ResEdit.NtExecutable.from(await Deno.readFile(executablePath));
  const resources = ResEdit.NtExecutableResource.from(pe);
  const iconFile = ResEdit.Data.IconFile.from(await Deno.readFile(iconPath));
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries,
    1,
    1033,
    iconFile.icons.map((item) => item.data),
  );
  resources.outputResource(pe);
  await Deno.writeFile(executablePath, new Uint8Array(pe.generate()));

  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(
    ResEdit.NtExecutableResource.from(
      ResEdit.NtExecutable.from(await Deno.readFile(executablePath)),
    ).entries,
  );
  if (!groups.some((group) => group.id === 1 && group.icons.length === iconFile.icons.length)) {
    throw new Error("Windows launcher icon resource verification failed");
  }
  console.log(`Embedded ${iconFile.icons.length} icon sizes into ${executablePath}`);
}

async function removeIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
