import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ResEdit from "resedit";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDirectory = join(root, "dist", "windows", "DSH-Desktop");
const executable = join(appDirectory, "DSH-Desktop.exe");
const icon = join(root, "assets", "icon.ico");
const packageRequested = Deno.args.length === 1 && Deno.args[0] === "--package";
if (Deno.args.length && !packageRequested) throw new Error("Expected only --package");

await runDesktop();
await embedIcon(executable, icon);
if (packageRequested) await buildArchive();

async function runDesktop(): Promise<void> {
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
      appDirectory,
      "--exclude-unused-npm",
      "main.ts",
    ],
    cwd: root,
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

async function buildArchive(): Promise<void> {
  const outputDirectory = join(root, "dist", "windows");
  const archive = join(outputDirectory, "DSH-Desktop-windows-x86_64.zip");
  try {
    await Deno.remove(archive);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  const windows = Deno.build.os === "windows";
  const command = new Deno.Command(windows ? "tar.exe" : "zip", {
    args: windows
      ? ["-a", "-c", "-f", archive, "-C", outputDirectory, "DSH-Desktop"]
      : ["-q", "-r", "-9", archive, "DSH-Desktop"],
    cwd: outputDirectory,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await command.spawn().status;
  if (!status.success) throw new Error(`ZIP packaging failed with exit code ${status.code}`);
}
