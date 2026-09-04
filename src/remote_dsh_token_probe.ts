import {
  type DshWebLaunchTokenCandidate,
  extractDshWebLaunchTokenCandidates,
  loopbackDshWebUrl,
} from "./dsh_web.ts";
import { type HiddenCommandOptions, runHiddenCommand } from "./hidden_process.ts";
import { probeHttp } from "./loopback_http.ts";
import type { ServerProfile } from "./profiles.ts";

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const SOURCE_MARKER = "__DSH_DESKTOP_TOKEN_PROBE_SOURCE__=";

export interface RemoteDshTokenProbeSource {
  readonly id: string;
  readonly script: string;
}

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

export const POSIX_REMOTE_DSH_TOKEN_PROBE_SOURCES: readonly RemoteDshTokenProbeSource[] = [
  {
    id: "tmux",
    script: `
if command -v tmux >/dev/null 2>&1; then
  tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null |
  while IFS= read -r pane; do
    tmux capture-pane -p -S -2000 -t "$pane" 2>/dev/null
  done
fi
`,
  },
  {
    id: "journalctl-user",
    script: `
if command -v journalctl >/dev/null 2>&1; then
  journalctl --user --no-pager -n 2000 2>/dev/null
fi
`,
  },
  {
    id: "journalctl-system",
    script: `
if command -v journalctl >/dev/null 2>&1; then
  journalctl --no-pager -n 2000 2>/dev/null
fi
`,
  },
  {
    id: "proc-fd-log",
    script: `
if [ -d /proc ]; then
  for fd in /proc/[0-9]*/fd/1 /proc/[0-9]*/fd/2; do
    [ -e "$fd" ] || continue
    pid="\${fd#/proc/}"
    pid="\${pid%%/*}"
    cmdline="$(tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    case "$cmdline" in
      *"dsh web"*|*"@deepseek-ai/dsh"*" web"*) ;;
      *) continue ;;
    esac
    target="$(readlink "$fd" 2>/dev/null)" || continue
    case "$target" in
      /*)
        [ -f "$target" ] || continue
        case "$target" in
          /dev/*|/proc/*|/sys/*) continue ;;
        esac
        tail -n 2000 -- "$target" 2>/dev/null
        ;;
    esac
  done
fi
`,
  },
];

export function posixRemoteDshTokenProbeProgram(
  sources: readonly RemoteDshTokenProbeSource[] = POSIX_REMOTE_DSH_TOKEN_PROBE_SOURCES,
): RemoteDshTokenProbeProgram {
  return {
    id: "posix-sh",
    args: (profile) => buildRemoteTokenProbeSshArguments(profile, ["sh", "-s"]),
    stdin: buildPosixRemoteDshTokenProbeScript(sources),
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

export function buildPosixRemoteDshTokenProbeScript(
  sources: readonly RemoteDshTokenProbeSource[] = POSIX_REMOTE_DSH_TOKEN_PROBE_SOURCES,
): string {
  return [
    "set +e",
    ...sources.map((source) =>
      [
        `printf '%s%s\\n' ${shellSingleQuote(SOURCE_MARKER)} ${shellSingleQuote(source.id)}`,
        `(${source.script}\n) 2>/dev/null || true`,
      ].join("\n")
    ),
  ].join("\n");
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

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
