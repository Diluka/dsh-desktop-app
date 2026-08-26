import { posix, win32 } from "node:path";

export interface AppPaths {
  readonly configFile: string;
  readonly logDirectory: string;
}

export type EnvironmentReader = (name: string) => string | undefined;

export function resolveAppPaths(
  os: typeof Deno.build.os = Deno.build.os,
  readEnvironment: EnvironmentReader = (name) => Deno.env.get(name),
): AppPaths {
  if (os !== "windows" && os !== "linux") {
    throw new Error(`Unsupported platform: ${os}`);
  }
  const joinPath = os === "windows" ? win32.join : posix.join;

  const home = readEnvironment(os === "windows" ? "USERPROFILE" : "HOME") ??
    readEnvironment("HOME");
  if (!home) {
    throw new Error("Cannot locate the current user's home directory");
  }

  const configRoot = os === "windows"
    ? readEnvironment("APPDATA") ?? joinPath(home, "AppData", "Roaming")
    : readEnvironment("XDG_CONFIG_HOME") ?? joinPath(home, ".config");
  const stateRoot = os === "windows"
    ? readEnvironment("LOCALAPPDATA") ?? joinPath(home, "AppData", "Local")
    : readEnvironment("XDG_STATE_HOME") ?? joinPath(home, ".local", "state");

  return {
    configFile: joinPath(configRoot, "dsh-desktop", "servers.json"),
    logDirectory: joinPath(stateRoot, "dsh-desktop", "logs"),
  };
}
