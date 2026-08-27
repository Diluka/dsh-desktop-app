import { assertEquals, assertThrows } from "@std/assert";
import { resolveAppPaths } from "../src/app_paths.ts";
import { directoryOpenCommand, externalUrlOpenCommand } from "../src/open_directory.ts";
import { setWindowsWindowIcon } from "../src/windows_window_icon.ts";
import { env } from "./test_helpers.ts";

Deno.test("resolveAppPaths uses the native platform path rules", () => {
  if (Deno.build.os === "windows") {
    assertEquals(
      resolveAppPaths(env({
        USERPROFILE: "C:\\Users\\Alice",
        APPDATA: "C:\\Users\\Alice\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local",
      })),
      {
        configFile: "C:\\Users\\Alice\\AppData\\Roaming\\dsh-desktop\\servers.json",
        logDirectory: "C:\\Users\\Alice\\AppData\\Local\\dsh-desktop\\logs",
      },
    );
    return;
  }

  if (Deno.build.os === "darwin") {
    assertEquals(resolveAppPaths(env({ HOME: "/Users/alice" })), {
      configFile: "/Users/alice/Library/Application Support/dsh-desktop/servers.json",
      logDirectory: "/Users/alice/Library/Logs/dsh-desktop",
    });
    return;
  }

  assertEquals(
    resolveAppPaths(env({
      HOME: "/home/alice",
      XDG_CONFIG_HOME: "/cfg",
      XDG_STATE_HOME: "/state",
    })),
    {
      configFile: "/cfg/dsh-desktop/servers.json",
      logDirectory: "/state/dsh-desktop/logs",
    },
  );
  assertEquals(resolveAppPaths(env({ HOME: "/home/alice" })), {
    configFile: "/home/alice/.config/dsh-desktop/servers.json",
    logDirectory: "/home/alice/.local/state/dsh-desktop/logs",
  });
});

Deno.test("resolveAppPaths fails when the user home directory is unavailable", () => {
  assertThrows(
    () => resolveAppPaths(env({})),
    Error,
    "Cannot locate the current user's home directory",
  );
});

Deno.test("Windows native icon API uses the scoped user32 permission", () => {
  if (Deno.build.os !== "windows") return;
  assertThrows(
    () => setWindowsWindowIcon(`missing-window-${crypto.randomUUID()}`),
    Error,
    "Native window was not found",
  );
});

Deno.test("directoryOpenCommand uses each platform's standard file manager", () => {
  assertEquals(directoryOpenCommand("windows", "C:\\logs"), {
    command: "explorer.exe",
    args: ["C:\\logs"],
  });
  assertEquals(directoryOpenCommand("darwin", "/Users/alice/Logs"), {
    command: "open",
    args: ["/Users/alice/Logs"],
  });
  assertEquals(directoryOpenCommand("linux", "/home/alice/logs"), {
    command: "xdg-open",
    args: ["/home/alice/logs"],
  });
});

Deno.test("externalUrlOpenCommand opens HTTPS URLs with the platform file manager", () => {
  const url = "https://github.com/Diluka/dsh-desktop-app/releases/tag/latest";
  assertEquals(externalUrlOpenCommand("windows", url), { command: "explorer.exe", args: [url] });
  assertEquals(externalUrlOpenCommand("darwin", url), { command: "open", args: [url] });
  assertEquals(externalUrlOpenCommand("linux", url), { command: "xdg-open", args: [url] });
  assertThrows(() => externalUrlOpenCommand("linux", "file:///etc/passwd"), Error, "HTTPS");
});
