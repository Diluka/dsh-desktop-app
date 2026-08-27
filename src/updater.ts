export const UPDATE_REPOSITORY = "Diluka/dsh-desktop-app";
export const UPDATE_RELEASE_URL = `https://github.com/${UPDATE_REPOSITORY}/releases/tag/latest`;
const RELEASE_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/tags/latest`;
const SHA_PATTERN = /^[0-9a-f]{40}$/iu;

type ReleasePayload = {
  readonly target_commitish?: unknown;
};

export interface UpdateInfo {
  readonly currentCommit: string;
  readonly latestCommit: string;
  readonly available: boolean;
  readonly releaseUrl: string;
}

export interface UpdateFetcher {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export async function checkForUpdate(
  currentCommit: string,
  fetcher: UpdateFetcher = fetch,
): Promise<UpdateInfo> {
  const normalizedCurrent = normalizeCommit(currentCommit, "当前版本");
  const release = await fetchRelease(fetcher);
  const latestCommit = normalizeCommit(release.target_commitish, "最新发布版本");
  return {
    currentCommit: normalizedCurrent,
    latestCommit,
    available: normalizedCurrent !== latestCommit,
    releaseUrl: UPDATE_RELEASE_URL,
  };
}

async function fetchRelease(fetcher: UpdateFetcher): Promise<ReleasePayload> {
  const response = await fetcher(RELEASE_API_URL, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`无法检查更新：GitHub 返回 HTTP ${response.status}`);
  return await response.json() as ReleasePayload;
}

function normalizeCommit(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new Error(`${label}缺少有效的 commit id`);
  }
  return value.toLowerCase();
}
