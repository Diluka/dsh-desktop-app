import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import { checkForUpdate, UPDATE_RELEASE_URL } from "../src/updater.ts";

const CURRENT = "1111111111111111111111111111111111111111";
const LATEST = "2222222222222222222222222222222222222222";

Deno.test("checkForUpdate compares the packaged commit with the latest release commit", async () => {
  const requests: string[] = [];
  const result = await checkForUpdate(CURRENT, (input, init) => {
    requests.push(String(input));
    assertEquals(init?.headers, { accept: "application/vnd.github+json" });
    return Promise.resolve(Response.json({ target_commitish: LATEST }));
  });

  assertEquals(result, {
    currentCommit: CURRENT,
    latestCommit: LATEST,
    available: true,
    releaseUrl: UPDATE_RELEASE_URL,
  });
  assertEquals(requests, [
    "https://api.github.com/repos/Diluka/dsh-desktop-app/releases/tags/latest",
  ]);
});

Deno.test("checkForUpdate reports no update when the commits match", async () => {
  const result = await checkForUpdate(CURRENT, releaseFetcher(CURRENT));
  assertEquals(result.available, false);
});

Deno.test("checkForUpdate rejects malformed release commit metadata", async () => {
  await assertRejects(
    () =>
      checkForUpdate(CURRENT, () => Promise.resolve(Response.json({ target_commitish: "latest" }))),
    Error,
    "commit id",
  );
});

Deno.test("checkForUpdate passes a timed abort signal to the fetcher", async () => {
  let receivedInit: RequestInit | undefined;
  await checkForUpdate(CURRENT, (_input, init) => {
    receivedInit = init;
    return Promise.resolve(Response.json({ target_commitish: CURRENT }));
  });
  assert(receivedInit?.signal instanceof AbortSignal);
  assertFalse(receivedInit.signal.aborted);
});

function releaseFetcher(commit: string) {
  return (): Promise<Response> => Promise.resolve(Response.json({ target_commitish: commit }));
}
