import { join } from "node:path";

export interface AppPaths {
  readonly configFile: string;
  readonly logDirectory: string;
}

export type EnvironmentReader = (name: string) => string | undefined;

export function resolveAppPaths(
  readEnvironment: EnvironmentReader = (name) => Deno.env.get(name),
): AppPaths {
  const os = Deno.build.os;
  if (os !== "windows" && os !== "linux" && os !== "darwin") {
    throw new Error(`Unsupported platform: ${os}`);
  }

  const home = readEnvironment(os === "windows" ? "USERPROFILE" : "HOME") ??
    readEnvironment("HOME");
  if (!home) {
    throw new Error("Cannot locate the current user's home directory");
  }

  const configRoot = os === "windows"
    ? readEnvironment("APPDATA") ?? join(home, "AppData", "Roaming")
    : os === "darwin"
    ? join(home, "Library", "Application Support")
    : readEnvironment("XDG_CONFIG_HOME") ?? join(home, ".config");
  const stateRoot = os === "windows"
    ? readEnvironment("LOCALAPPDATA") ?? join(home, "AppData", "Local")
    : os === "darwin"
    ? join(home, "Library", "Logs")
    : readEnvironment("XDG_STATE_HOME") ?? join(home, ".local", "state");

  return {
    configFile: join(configRoot, "dsh-desktop", "servers.json"),
    logDirectory: os === "darwin"
      ? join(stateRoot, "dsh-desktop")
      : join(stateRoot, "dsh-desktop", "logs"),
  };
}
