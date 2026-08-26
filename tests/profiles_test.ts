import { assertEquals, assertRejects } from "@std/assert";
import { DEFAULT_REMOTE_PORT, ProfileStore, ProfileValidationError } from "../src/profiles.ts";
import { tempFile } from "./test_helpers.ts";

Deno.test("ProfileStore defaults port, validates input, persists and deletes", async () => {
  const filePath = await tempFile("servers.json");
  const { store } = await ProfileStore.open(filePath, { createId: () => "profile-1" });

  const saved = await store.save({ name: "", sshTarget: " prod-dsh " });
  assertEquals(saved, {
    id: "profile-1",
    name: "prod-dsh",
    sshTarget: "prod-dsh",
    remotePort: DEFAULT_REMOTE_PORT,
  });
  assertEquals(JSON.parse(await Deno.readTextFile(filePath)).profiles, [saved]);

  await assertRejects(
    () => store.save({ name: "bad", sshTarget: "-oProxyCommand=evil", remotePort: 3080 }),
    ProfileValidationError,
  );
  await assertRejects(
    () => store.save({ name: "bad", sshTarget: "prod dsh", remotePort: 3080 }),
    ProfileValidationError,
  );
  await assertRejects(
    () => store.save({ name: "bad", sshTarget: "prod", remotePort: 65536 }),
    ProfileValidationError,
  );
  await assertRejects(
    () => store.delete(123),
    ProfileValidationError,
  );

  assertEquals(await store.delete("profile-1"), true);
  assertEquals(store.list(), []);
  assertEquals(JSON.parse(await Deno.readTextFile(filePath)).profiles, []);
  assertEquals(await store.delete("missing"), false);
});

Deno.test("ProfileStore.save updates an existing profile id instead of duplicating it", async () => {
  const filePath = await tempFile("servers.json");
  let nextId = 1;
  const { store } = await ProfileStore.open(filePath, { createId: () => `profile-${nextId++}` });

  const original = await store.save({ name: "Production", sshTarget: "prod-dsh" });
  const updated = await store.save({
    id: original.id,
    name: "Staging",
    sshTarget: "staging-dsh",
    remotePort: "48080",
  });

  assertEquals(updated, {
    id: "profile-1",
    name: "Staging",
    sshTarget: "staging-dsh",
    remotePort: 48080,
  });
  assertEquals(store.list(), [updated]);
  assertEquals(JSON.parse(await Deno.readTextFile(filePath)).profiles, [updated]);
});

Deno.test("ProfileStore backs up corrupt config and recovers empty store", async () => {
  const filePath = await tempFile("servers.json");
  await Deno.writeTextFile(filePath, "not json");

  const opened = await ProfileStore.open(filePath, {
    now: () => new Date("2025-01-02T03:04:05.000Z"),
  });

  assertEquals(opened.store.list(), []);
  assertEquals(opened.recoveredBackup, `${filePath}.invalid-2025-01-02T03-04-05.000Z`);
  assertEquals(await Deno.readTextFile(opened.recoveredBackup!), "not json");
  await assertRejects(() => Deno.readTextFile(filePath), Deno.errors.NotFound);
});

Deno.test("ProfileStore backs up config with boolean port", async () => {
  const filePath = await tempFile("servers.json");
  await Deno.writeTextFile(
    filePath,
    JSON.stringify({
      version: 1,
      profiles: [{
        id: "profile-1",
        name: "Production",
        sshTarget: "prod-dsh",
        remotePort: true,
      }],
    }),
  );

  const opened = await ProfileStore.open(filePath, {
    now: () => new Date("2025-01-02T03:04:05.000Z"),
  });

  assertEquals(opened.store.list(), []);
  assertEquals(opened.recoveredBackup, `${filePath}.invalid-2025-01-02T03-04-05.000Z`);
});

function acceptsSaveInput(_input: Parameters<ProfileStore["save"]>[0]): void {}

// @ts-expect-error remotePort only accepts browser form text or numeric ports.
acceptsSaveInput({ name: "bad", sshTarget: "prod", remotePort: true });
