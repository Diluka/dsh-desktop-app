import { join } from "node:path";
import { createLogger } from "../src/logger.ts";

export const LOG_FILE_PATTERN = /^dsh-desktop-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{9}Z\.jsonl$/u;

export function env(values: Record<string, string | undefined>) {
  return (name: string) => values[name];
}

export async function tempFile(name: string) {
  const directory = await Deno.makeTempDir();
  return join(directory, name);
}

export function profile() {
  return { id: "p1", name: "Production", sshTarget: "prod-dsh", remotePort: 3080, dshWebToken: "" };
}

export async function memoryLogger() {
  const directory = await Deno.makeTempDir();
  const logger = await createLogger(directory);
  return { logger, filePath: await findLogFile(directory) };
}

export async function findLogFile(directory: string) {
  const [file] = await findLogFiles(directory);
  if (!file) throw new Error("Pino log file was not created");
  return file;
}

export async function findLogFiles(directory: string) {
  const files: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isFile && LOG_FILE_PATTERN.test(entry.name)) files.push(join(directory, entry.name));
  }
  return files;
}

export function tickingClock(initial: number, step: number) {
  let value = initial;
  return () => {
    const current = value;
    value += step;
    return current;
  };
}

export function fakeChild(outputFile = "") {
  let finish!: (status: Deno.CommandStatus & { error?: Error }) => void;
  const status = new Promise<Deno.CommandStatus & { error?: Error }>((resolve) => {
    finish = resolve;
  });
  return {
    outputFile,
    status,
    kills: [] as Array<Deno.Signal | undefined>,
    kill(signal?: Deno.Signal) {
      this.kills.push(signal);
    },
    finish,
  };
}
