import { dirname } from "node:path";

export const DEFAULT_REMOTE_PORT = 3080;
const CONFIG_VERSION = 1;

export type ConnectionMode = "remote" | "local";

export interface ServerProfile {
  readonly id: string;
  readonly name: string;
  readonly sshTarget: string;
  readonly remotePort: number;
  readonly dshWebToken: string;
}

export interface ServerProfileInput {
  readonly id?: string | null;
  readonly name?: string | null;
  readonly sshTarget: string;
  readonly remotePort?: string | number | null;
  readonly dshWebToken?: string | null;
}

interface ProfileFile {
  readonly version: typeof CONFIG_VERSION;
  readonly profiles: readonly ServerProfile[];
  readonly mode: ConnectionMode;
  readonly lastProfileId?: string;
}

export interface OpenProfileStoreResult {
  readonly store: ProfileStore;
  readonly recoveredBackup?: string;
}

export class ProfileValidationError extends Error {
  override name = "ProfileValidationError";
}

export class ProfileStore {
  #profiles: ServerProfile[];
  #mode: ConnectionMode;
  #lastProfileId?: string;

  private constructor(
    readonly filePath: string,
    profiles: ServerProfile[],
    mode: ConnectionMode,
    lastProfileId: string | undefined,
    private readonly createId: () => string,
  ) {
    this.#profiles = profiles;
    this.#mode = mode;
    this.#lastProfileId = lastProfileId;
  }

  static async open(
    filePath: string,
    options: { createId?: () => string; now?: () => Date } = {},
  ): Promise<OpenProfileStoreResult> {
    const createId = options.createId ?? (() => crypto.randomUUID());
    const now = options.now ?? (() => new Date());

    try {
      const raw = await Deno.readTextFile(filePath);
      const parsed = parseProfileFile(raw);
      return {
        store: new ProfileStore(
          filePath,
          parsed.profiles,
          parsed.mode,
          parsed.lastProfileId,
          createId,
        ),
      };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return { store: new ProfileStore(filePath, [], "remote", undefined, createId) };
      }
      if (!(error instanceof SyntaxError || error instanceof ProfileValidationError)) {
        throw error;
      }

      const stamp = now().toISOString().replaceAll(":", "-");
      const recoveredBackup = `${filePath}.invalid-${stamp}`;
      await Deno.rename(filePath, recoveredBackup);
      return {
        store: new ProfileStore(filePath, [], "remote", undefined, createId),
        recoveredBackup,
      };
    }
  }

  list(): ServerProfile[] {
    const profiles = this.#profiles.map((profile) => ({ ...profile }));
    const lastIndex = profiles.findIndex((profile) => profile.id === this.#lastProfileId);
    if (lastIndex > 0) profiles.unshift(profiles.splice(lastIndex, 1)[0]);
    return profiles;
  }

  connectionMode(): ConnectionMode {
    return this.#mode;
  }

  get(id: string): ServerProfile | undefined {
    const profile = this.#profiles.find((candidate) => candidate.id === id);
    return profile ? { ...profile } : undefined;
  }

  async setConnectionMode(mode: unknown): Promise<void> {
    if (mode !== "remote" && mode !== "local") {
      throw new ProfileValidationError("连接模式无效");
    }
    if (this.#mode === mode) return;
    this.#mode = mode;
    await this.#persist();
  }

  async markUsed(id: string): Promise<void> {
    if (!this.#profiles.some((profile) => profile.id === id)) {
      throw new ProfileValidationError("服务器配置不存在或已被删除");
    }
    if (this.#lastProfileId === id) return;
    this.#lastProfileId = id;
    await this.#persist();
  }

  async save(input: ServerProfileInput): Promise<ServerProfile> {
    const requestedId = typeof input.id === "string" ? input.id : undefined;
    const existingIndex = requestedId
      ? this.#profiles.findIndex((profile) => profile.id === requestedId)
      : -1;
    const sshTarget = validateSshTarget(input.sshTarget);
    const profile: ServerProfile = {
      id: existingIndex >= 0 ? this.#profiles[existingIndex].id : this.createId(),
      name: validateName(input.name, sshTarget),
      sshTarget,
      remotePort: validatePort(input.remotePort),
      dshWebToken: input.dshWebToken ?? "",
    };

    if (existingIndex >= 0) {
      this.#profiles[existingIndex] = profile;
    } else {
      this.#profiles.push(profile);
    }
    await this.#persist();
    return { ...profile };
  }

  async delete(id: unknown): Promise<boolean> {
    if (typeof id !== "string") {
      throw new ProfileValidationError("服务器 ID 无效");
    }
    const next = this.#profiles.filter((profile) => profile.id !== id);
    if (next.length === this.#profiles.length) return false;
    this.#profiles = next;
    if (this.#lastProfileId === id) this.#lastProfileId = undefined;
    await this.#persist();
    return true;
  }

  async #persist(): Promise<void> {
    await Deno.mkdir(dirname(this.filePath), { recursive: true });
    const data: ProfileFile = {
      version: CONFIG_VERSION,
      profiles: this.#profiles,
      mode: this.#mode,
      ...(this.#lastProfileId ? { lastProfileId: this.#lastProfileId } : {}),
    };
    await Deno.writeTextFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
  }
}

function parseProfileFile(raw: string): {
  profiles: ServerProfile[];
  mode: ConnectionMode;
  lastProfileId?: string;
} {
  const value: unknown = JSON.parse(raw);
  const record = asRecord(value);
  if (record.version !== CONFIG_VERSION || !Array.isArray(record.profiles)) {
    throw new ProfileValidationError("服务器配置版本或结构无效");
  }

  const ids = new Set<string>();
  const profiles = record.profiles.map((item) => {
    const profile = asRecord(item);
    if (typeof profile.id !== "string" || profile.id.length === 0 || ids.has(profile.id)) {
      throw new ProfileValidationError("服务器配置包含无效或重复的 ID");
    }
    ids.add(profile.id);
    const sshTarget = validateSshTarget(profile.sshTarget);
    return {
      id: profile.id,
      name: validateName(profile.name, sshTarget),
      sshTarget,
      remotePort: validateStoredPort(profile.remotePort),
      dshWebToken: (profile.dshWebToken ?? "") as string,
    };
  });
  const mode = record.mode === "local" ? "local" : "remote";
  const lastProfileId = typeof record.lastProfileId === "string" && ids.has(record.lastProfileId)
    ? record.lastProfileId
    : undefined;
  return { profiles, mode, ...(lastProfileId ? { lastProfileId } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProfileValidationError("服务器配置必须是对象");
  }
  return value as Record<string, unknown>;
}

function validateName(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") {
    throw new ProfileValidationError("服务器名称必须是文本");
  }
  const name = value.trim();
  if (name.length === 0 || name.length > 80 || hasControlCharacter(name)) {
    throw new ProfileValidationError("服务器名称长度需为 1-80 个字符");
  }
  return name;
}

function validateSshTarget(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProfileValidationError("SSH Host 必须是文本");
  }
  const target = value.trim();
  if (
    target.length === 0 || target.length > 255 || target.startsWith("-") ||
    /\s/u.test(target) || hasControlCharacter(target)
  ) {
    throw new ProfileValidationError("SSH Host 应为 .ssh/config 中的 Host 或 user@host");
  }
  return target;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function validatePort(value: string | number | null | undefined): number {
  const port = value === undefined || value === null || value === ""
    ? DEFAULT_REMOTE_PORT
    : typeof value === "number"
    ? value
    : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProfileValidationError("DSH Web 端口必须是 1-65535 的整数");
  }
  return port;
}

function validateStoredPort(value: unknown): number {
  if (
    typeof value === "string" || typeof value === "number" || value === null ||
    value === undefined
  ) {
    return validatePort(value);
  }
  throw new ProfileValidationError("DSH Web 端口必须是 1-65535 的整数");
}
