export interface DshWebLaunchTokenCandidate {
  readonly url: string;
  readonly token: string;
}

const DSH_WEB_PREFIX = "dsh web:";

export function loopbackDshWebUrl(port: number, token: string): string {
  const url = new URL(`http://127.0.0.1:${port}/`);
  url.searchParams.set("token", token);
  return url.href;
}

export function extractDshWebLaunchTokenCandidates(
  output: string,
): DshWebLaunchTokenCandidate[] {
  const candidates: DshWebLaunchTokenCandidate[] = [];

  for (const line of output.split(/\r?\n/u)) {
    const candidate = dshWebLaunchTokenCandidateFromLine(line);
    if (candidate) candidates.push(candidate);
  }

  return candidates;
}

export function latestDshWebLaunchTokenUrl(output: string): string | undefined {
  return extractDshWebLaunchTokenCandidates(output).at(-1)?.url;
}

function dshWebLaunchTokenCandidateFromLine(
  line: string,
): DshWebLaunchTokenCandidate | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(DSH_WEB_PREFIX)) return undefined;
  const [value] = trimmed.slice(DSH_WEB_PREFIX.length).trimStart().split(/\s+/u, 1);
  if (!value) return undefined;

  try {
    const url = new URL(value);
    const token = url.searchParams.get("token");
    return token ? { url: url.href, token } : undefined;
  } catch {
    // Ignore incomplete output while dsh web is starting.
    return undefined;
  }
}
