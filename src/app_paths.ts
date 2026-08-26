import { join } from "node:path";

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

  const home = readEnvironment(os === "windows" ? "USERPROFILE" : "HOME") ??
    readEnvironment("HOME");
  if (!home) {
    throw new Error("Cannot locate the current user's home directory");
  }

  const configRoot = os === "windows"
    ? readEnvironment("APPDATA") ?? join(home, "AppData", "Roaming")
    : readEnvironment("XDG_CONFIG_HOME") ?? join(home, ".config");
  const stateRoot = os === "windows"
    ? readEnvironment("LOCALAPPDATA") ?? join(home, "AppData", "Local")
    : readEnvironment("XDG_STATE_HOME") ?? join(home, ".local", "state");

  return {
    configFile: join(configRoot, "dsh-desktop", "servers.json"),
    logDirectory: join(stateRoot, "dsh-desktop", "logs"),
  };
}
