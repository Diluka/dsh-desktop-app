import {
  type DshWebLaunchTokenCandidate,
  extractDshWebLaunchTokenCandidates,
  loopbackDshWebUrl,
} from "./dsh_web.ts";
import { type HiddenCommandOptions, runHiddenCommand } from "./hidden_process.ts";
import { probeHttp } from "./loopback_http.ts";
import type { ServerProfile } from "./profiles.ts";
import POSIX_REMOTE_DSH_TOKEN_PROBE_SCRIPT from "./remote_dsh_token_probe_posix.sh" with {
  type: "text",
};

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const SOURCE_MARKER = "__DSH_DESKTOP_TOKEN_PROBE_SOURCE__=";

export interface RemoteDshTokenProbeProgram {
  readonly id: string;
  readonly args: (profile: ServerProfile) => string[];
  readonly stdin?: string;
}

export interface RemoteDshTokenProbeCommandOutput {
  readonly success: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RemoteDshTokenProbeOptions {
  readonly command?: string;
  readonly programs?: readonly RemoteDshTokenProbeProgram[];
  readonly timeoutMilliseconds?: number;
  readonly run?: (
    command: string,
    args: string[],
    options: HiddenCommandOptions,
  ) => Promise<RemoteDshTokenProbeCommandOutput>;
}

export interface RemoteDshWebTokenCandidate extends DshWebLaunchTokenCandidate {
  readonly sourceId: string;
}

export interface RecoverRemoteDshWebTokenOptions extends RemoteDshTokenProbeOptions {
  readonly probe?: (url: string) => Promise<number>;
}

export type RecoveredRemoteDshWebToken = RemoteDshWebTokenCandidate;

export function posixRemoteDshTokenProbeProgram(
  script = POSIX_REMOTE_DSH_TOKEN_PROBE_SCRIPT,
): RemoteDshTokenProbeProgram {
  return {
    id: "posix-sh",
    args: (profile) => buildRemoteTokenProbeSshArguments(profile, ["sh", "-s"]),
    stdin: script,
  };
}

export function defaultRemoteDshTokenProbePrograms(): readonly RemoteDshTokenProbeProgram[] {
  return [posixRemoteDshTokenProbeProgram()];
}

export function buildRemoteTokenProbeSshArguments(
  profile: ServerProfile,
  remoteCommand: readonly string[],
): string[] {
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=12",
    "--",
    profile.sshTarget,
    ...remoteCommand,
  ];
}

export async function collectRemoteDshWebTokenCandidates(
  profile: ServerProfile,
  options: RemoteDshTokenProbeOptions = {},
): Promise<RemoteDshWebTokenCandidate[]> {
  const command = options.command ?? "ssh";
  const programs = options.programs ?? defaultRemoteDshTokenProbePrograms();
  const timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_PROBE_TIMEOUT_MS;
  const run = options.run ?? runHiddenCommand;
  const candidates: RemoteDshWebTokenCandidate[] = [];

  for (const program of programs) {
    let output: RemoteDshTokenProbeCommandOutput;
    try {
      output = await run(command, program.args(profile), {
        timeoutMilliseconds,
        ...(program.stdin !== undefined ? { stdin: program.stdin } : {}),
      });
    } catch {
      continue;
    }
    if (!output.success) continue;
    candidates.push(...extractRemoteDshWebTokenCandidates(output.stdout, program.id));
    candidates.push(...extractRemoteDshWebTokenCandidates(output.stderr, program.id));
  }

  return uniqueTokenCandidates(candidates);
}

export async function recoverRemoteDshWebToken(
  profile: ServerProfile,
  localPort: number,
  options: RecoverRemoteDshWebTokenOptions = {},
): Promise<RecoveredRemoteDshWebToken | undefined> {
  const candidates = await collectRemoteDshWebTokenCandidates(profile, options);
  const probe = options.probe ?? ((url) =>
    probeHttp(url, {
      accept: "text/html",
      validateStatus: () => true,
    }));

  for (const candidate of candidates) {
    const url = loopbackDshWebUrl(localPort, candidate.token);
    let status: number;
    try {
      status = await probe(url);
    } catch {
      continue;
    }
    if (status >= 200 && status < 400) return candidate;
  }

  return undefined;
}

export function extractRemoteDshWebTokenCandidates(
  output: string,
  fallbackSourceId = "unknown",
): RemoteDshWebTokenCandidate[] {
  const candidates: RemoteDshWebTokenCandidate[] = [];
  let sourceId = fallbackSourceId;

  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith(SOURCE_MARKER)) {
      sourceId = line.slice(SOURCE_MARKER.length);
      continue;
    }
    for (const candidate of extractDshWebLaunchTokenCandidates(line)) {
      candidates.push({ ...candidate, sourceId });
    }
  }

  return uniqueTokenCandidates(candidates);
}

function uniqueTokenCandidates(
  candidates: readonly RemoteDshWebTokenCandidate[],
): RemoteDshWebTokenCandidate[] {
  const seen = new Set<string>();
  const unique: RemoteDshWebTokenCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.token)) continue;
    seen.add(candidate.token);
    unique.push(candidate);
  }
  return unique;
}
