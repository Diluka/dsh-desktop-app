import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import {
  checkForUpdate,
  downloadUpdate,
  macosApplyCommand,
  selectReleaseAsset,
  startUpdateApplier,
  windowsApplyCommand,
} from "../src/updater.ts";

const CURRENT = "1111111111111111111111111111111111111111";
const LATEST = "2222222222222222222222222222222222222222";
const WINDOWS_ASSET = "DSH-Desktop-windows-x86_64-cef.zip";
const RELEASE_URL = "https://downloads.example.invalid/update.zip";
const ARCHIVE_CONTENT = "desktop archive";
const ARCHIVE_SIZE = new TextEncoder().encode(ARCHIVE_CONTENT).byteLength;

Deno.test("checkForUpdate compares the packaged commit with the latest release commit", async () => {
  const result = await checkForUpdate(CURRENT, releaseFetcher(LATEST));
  assertEquals(result, {
    currentCommit: CURRENT,
    latestCommit: LATEST,
    available: true,
    releaseUrl: "https://github.com/Diluka/dsh-desktop-app/releases/tag/latest",
  });
});

Deno.test("checkForUpdate reports no update when the commits match", async () => {
  const result = await checkForUpdate(CURRENT, releaseFetcher(CURRENT));
  assertEquals(result.available, false);
});

Deno.test("checkForUpdate rejects malformed release commit metadata", async () => {
  await assertRejects(
    () =>
      checkForUpdate(CURRENT, () => Promise.resolve(Response.json({ target_commitish: "latest" }))),
    Error,
    "commit id",
  );
});

Deno.test("downloadUpdate persists a complete matching platform archive after commit revalidation", async () => {
  const directory = await Deno.makeTempDir();
  const requests: string[] = [];
  let releaseCalls = 0;
  const fetcher = (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    requests.push(url);
    if (url.includes("api.github.com")) {
      releaseCalls += 1;
      return Promise.resolve(Response.json(releasePayload(LATEST)));
    }
    return Promise.resolve(new Response(ARCHIVE_CONTENT));
  };

  try {
    const result = await downloadUpdate(CURRENT, {
      paths: { updateDirectory: directory },
      backend: "cef",
      fetcher,
      platform: { os: "windows", arch: "x86_64" },
    });
    assertEquals(result.assetName, WINDOWS_ASSET);
    assertEquals(result.downloadedBytes, ARCHIVE_SIZE);
    assertEquals(await Deno.readTextFile(`${directory}/${WINDOWS_ASSET}`), ARCHIVE_CONTENT);
    assertEquals(releaseCalls, 2);
    assertEquals(requests.at(-1), RELEASE_URL);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("downloadUpdate rejects a release that changes between check and download", async () => {
  let releaseCalls = 0;
  const fetcher = (): Promise<Response> => {
    releaseCalls += 1;
    return Promise.resolve(Response.json(releasePayload(releaseCalls === 1 ? LATEST : CURRENT)));
  };
  await assertRejects(
    () =>
      downloadUpdate(CURRENT, {
        paths: { updateDirectory: "/tmp/update" },
        backend: "cef",
        fetcher,
        platform: { os: "windows", arch: "x86_64" },
      }),
    Error,
    "发生变化",
  );
});

Deno.test("downloadUpdate rejects an incomplete archive and removes its partial file", async () => {
  const directory = await Deno.makeTempDir();
  const fetcher = (input: RequestInfo | URL): Promise<Response> => {
    if (String(input).includes("api.github.com")) {
      return Promise.resolve(Response.json(releasePayload(LATEST, ARCHIVE_SIZE + 1)));
    }
    return Promise.resolve(new Response(ARCHIVE_CONTENT));
  };

  try {
    await assertRejects(
      () =>
        downloadUpdate(CURRENT, {
          paths: { updateDirectory: directory },
          backend: "cef",
          fetcher,
          platform: { os: "windows", arch: "x86_64" },
        }),
      Error,
      "不完整",
    );
    await assertRejects(
      () => Deno.stat(`${directory}/${WINDOWS_ASSET}.part`),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("selectReleaseAsset maps supported platforms to release artifact names", () => {
  assertEquals(
    selectReleaseAsset({ os: "windows", arch: "x86_64" }, "webview"),
    "DSH-Desktop-windows-x86_64-webview.zip",
  );
  assertEquals(
    selectReleaseAsset({ os: "darwin", arch: "aarch64" }),
    "DSH-Desktop-macos-aarch64.tar.gz",
  );
  assertEquals(
    selectReleaseAsset({ os: "darwin", arch: "x86_64" }),
    "DSH-Desktop-macos-x86_64.tar.gz",
  );
  assertThrows(
    () => selectReleaseAsset({ os: "linux", arch: "x86_64" }),
    Error,
    "不支持自动更新",
  );
});

Deno.test("startUpdateApplier launches an independent Windows process before shutdown", () => {
  let actualCommand = "";
  let actualArgs: string[] = [];
  let actualOptions: { detached: true; stdio: "ignore"; windowsHide: true } | undefined;
  let unreferenced = false;
  startUpdateApplier({
    executablePath: "C:\\Apps\\DSH-Desktop-CEF\\DSH-Desktop.exe",
    updateDirectory: "C:\\Users\\Alice\\AppData\\Local\\dsh-desktop\\updates",
    assetName: WINDOWS_ASSET,
    parentPid: 48,
    platform: { os: "windows", arch: "x86_64" },
    spawnProcess(command, args, options) {
      actualCommand = command;
      actualArgs = args;
      actualOptions = options;
      return {
        unref() {
          unreferenced = true;
        },
      };
    },
  });
  assertEquals(actualCommand, "cmd.exe");
  assertEquals(actualArgs.slice(0, 3), ["/d", "/s", "/c"]);
  assertStringIncludes(actualArgs[3], "Wait-Process -Id 48 -ErrorAction SilentlyContinue");
  assertEquals(actualOptions, { detached: true, stdio: "ignore", windowsHide: true });
  assertEquals(unreferenced, true);
});

Deno.test("Windows apply command stages, swaps, restarts, then cleans up", () => {
  const command = windowsApplyCommand(
    "C:\\Apps\\DSH-Desktop-CEF\\DSH-Desktop.exe",
    "C:\\Users\\Alice\\AppData\\Local\\dsh-desktop\\updates",
    WINDOWS_ASSET,
    48,
  );
  assertStringIncludes(command, "Wait-Process -Id 48 -ErrorAction SilentlyContinue");
  assertStringIncludes(command, 'if exist "C:\\Apps\\.DSH-Desktop-CEF.update-staging"');
  assertStringIncludes(command, "tar -xf");
  assertStringIncludes(command, 'move "C:\\Apps\\DSH-Desktop-CEF"');
  assertStringIncludes(command, 'start "" "C:\\Apps\\DSH-Desktop-CEF\\DSH-Desktop.exe"');
});

Deno.test("Windows apply command rejects cmd-expanded paths", () => {
  assertThrows(
    () =>
      windowsApplyCommand(
        "C:\\Apps\\%USERPROFILE%\\DSH-Desktop.exe",
        "C:\\Users\\Alice\\AppData\\Local\\dsh-desktop\\updates",
        WINDOWS_ASSET,
      ),
    Error,
    "百分号",
  );
});

Deno.test("macOS apply command waits for shutdown, replaces the bundle, and relaunches it", () => {
  const command = macosApplyCommand(
    "/Applications/DSH-Desktop.app/Contents/MacOS/DSH-Desktop",
    "/Users/alice/Library/Logs/dsh-desktop/updates",
    "DSH-Desktop-macos-aarch64.tar.gz",
    48,
  );
  assertStringIncludes(command, "set -e; while kill -0 48");
  assertStringIncludes(command, "tar -xzf");
  assertStringIncludes(command, "mv '/Applications/DSH-Desktop.app'");
  assertStringIncludes(command, "open '/Applications/DSH-Desktop.app'");
});

function releaseFetcher(commit: string) {
  return (): Promise<Response> =>
    Promise.resolve(Response.json({ target_commitish: commit, assets: [] }));
}

function releasePayload(commit: string, size = ARCHIVE_SIZE) {
  return {
    target_commitish: commit,
    assets: [{ name: WINDOWS_ASSET, browser_download_url: RELEASE_URL, size }],
  };
}
