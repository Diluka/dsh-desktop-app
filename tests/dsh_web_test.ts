import { assertEquals } from "@std/assert";
import { extractDshWebLaunchTokenCandidates, loopbackDshWebUrl } from "../src/dsh_web.ts";

Deno.test("loopbackDshWebUrl always writes the token query", () => {
  assertEquals(loopbackDshWebUrl(41000, ""), "http://127.0.0.1:41000/?token=");
  assertEquals(
    loopbackDshWebUrl(41000, "manual-token"),
    "http://127.0.0.1:41000/?token=manual-token",
  );
});

Deno.test("extractDshWebLaunchTokenCandidates reads token from printed dsh web URLs", () => {
  const output = [
    "warming up",
    "dsh web: https://example.invalid/custom/path?source=terminal&token=first&future=1",
    "ignored: http://127.0.0.1:3080/?token=not-from-prefix",
    "dsh web: http://127.0.0.1:3080/?token=second trailing text",
  ].join("\n");

  assertEquals(extractDshWebLaunchTokenCandidates(output), [
    {
      token: "first",
      url: "https://example.invalid/custom/path?source=terminal&token=first&future=1",
    },
    { token: "second", url: "http://127.0.0.1:3080/?token=second" },
  ]);
});

Deno.test("extractDshWebLaunchTokenCandidates ignores URLs without a token value", () => {
  assertEquals(
    extractDshWebLaunchTokenCandidates([
      "dsh web: http://127.0.0.1:3080/",
      "dsh web: http://127.0.0.1:3080/?token=",
      "dsh web: not-yet-a-url",
    ].join("\n")),
    [],
  );
});
