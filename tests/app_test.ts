import { assertRejects } from "@std/assert";
import { startDesktop } from "../app.ts";

Deno.test("startDesktop cleans up the shell server when home environment is missing", async () => {
  const originalHome = Deno.env.get("HOME");
  const originalUserProfile = Deno.env.get("USERPROFILE");
  Deno.env.delete("HOME");
  Deno.env.delete("USERPROFILE");
  try {
    await assertRejects(
      () => startDesktop("cef"),
      Error,
      "Cannot locate the current user's home directory",
    );
  } finally {
    restoreEnvironment("HOME", originalHome);
    restoreEnvironment("USERPROFILE", originalUserProfile);
  }
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    Deno.env.delete(name);
  } else {
    Deno.env.set(name, value);
  }
}
