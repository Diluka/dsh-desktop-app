import { dirname } from "node:path";

export const DEFAULT_REMOTE_PORT = 3080;
const CONFIG_VERSION = 1;

export interface ServerProfile {
  readonly id: string;
  readonly name: string;
  readonly sshTarget: string;
  readonly remotePort: number;
}

interface ProfileFile {
  readonly version: typeof CONFIG_VERSION;
  readonly profiles: readonly ServerProfile[];
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

  private constructor(
    readonly filePath: string,
    profiles: ServerProfile[],
    private readonly createId: () => string,
  ) {
    this.#profiles = profiles;
  }

  static async open(
    filePath: string,
    options: { createId?: () => string; now?: () => Date } = {},
  ): Promise<OpenProfileStoreResult> {
    const createId = options.createId ?? (() => crypto.randomUUID());
    const now = options.now ?? (() => new Date());

    try {
      const raw = await Deno.readTextFile(filePath);
      return {
        store: new ProfileStore(filePath, parseProfileFile(raw), createId),
      };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return { store: new ProfileStore(filePath, [], createId) };
      }
      if (!(error instanceof SyntaxError || error instanceof ProfileValidationError)) {
        throw error;
      }

      const stamp = now().toISOString().replaceAll(":", "-");
      const recoveredBackup = `${filePath}.invalid-${stamp}`;
      await Deno.rename(filePath, recoveredBackup);
      return {
        store: new ProfileStore(filePath, [], createId),
        recoveredBackup,
      };
    }
  }

  list(): ServerProfile[] {
    return this.#profiles.map((profile) => ({ ...profile }));
  }

  get(id: string): ServerProfile | undefined {
    const profile = this.#profiles.find((candidate) => candidate.id === id);
    return profile ? { ...profile } : undefined;
  }

  async save(input: unknown): Promise<ServerProfile> {
    const record = asRecord(input);
    const requestedId = typeof record.id === "string" ? record.id : undefined;
    const existingIndex = requestedId
      ? this.#profiles.findIndex((profile) => profile.id === requestedId)
      : -1;
    const sshTarget = validateSshTarget(record.sshTarget);
    const profile: ServerProfile = {
      id: existingIndex >= 0 ? this.#profiles[existingIndex].id : this.createId(),
      name: validateName(record.name, sshTarget),
      sshTarget,
      remotePort: validatePort(record.remotePort),
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
    await this.#persist();
    return true;
  }

  async #persist(): Promise<void> {
    await Deno.mkdir(dirname(this.filePath), { recursive: true });
    const data: ProfileFile = {
      version: CONFIG_VERSION,
      profiles: this.#profiles,
    };
    await Deno.writeTextFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
  }
}

function parseProfileFile(raw: string): ServerProfile[] {
  const value: unknown = JSON.parse(raw);
  const record = asRecord(value);
  if (record.version !== CONFIG_VERSION || !Array.isArray(record.profiles)) {
    throw new ProfileValidationError("服务器配置版本或结构无效");
  }

  const ids = new Set<string>();
  return record.profiles.map((item) => {
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
      remotePort: validatePort(profile.remotePort),
    };
  });
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

function validatePort(value: unknown): number {
  const port = value === undefined || value === null || value === ""
    ? DEFAULT_REMOTE_PORT
    : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProfileValidationError("DSH Web 端口必须是 1-65535 的整数");
  }
  return port;
}
