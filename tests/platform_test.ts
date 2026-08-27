import { assertEquals, assertThrows } from "@std/assert";
import { resolveAppPaths } from "../src/app_paths.ts";
import { directoryOpenCommand } from "../src/open_directory.ts";
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
        updateDirectory: "C:\\Users\\Alice\\AppData\\Local\\dsh-desktop\\updates",
      },
    );
    return;
  }

  if (Deno.build.os === "darwin") {
    assertEquals(resolveAppPaths(env({ HOME: "/Users/alice" })), {
      configFile: "/Users/alice/Library/Application Support/dsh-desktop/servers.json",
      logDirectory: "/Users/alice/Library/Logs/dsh-desktop",
      updateDirectory: "/Users/alice/Library/Logs/dsh-desktop/updates",
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
      updateDirectory: "/state/dsh-desktop/updates",
    },
  );
  assertEquals(resolveAppPaths(env({ HOME: "/home/alice" })), {
    configFile: "/home/alice/.config/dsh-desktop/servers.json",
    logDirectory: "/home/alice/.local/state/dsh-desktop/logs",
    updateDirectory: "/home/alice/.local/state/dsh-desktop/updates",
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
