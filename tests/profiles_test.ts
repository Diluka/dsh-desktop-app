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

Deno.test("ProfileStore persists and clears an optional DSH Web token", async () => {
  const filePath = await tempFile("servers.json");
  const { store } = await ProfileStore.open(filePath, { createId: () => "profile-1" });

  const saved = await store.save({
    name: "Production",
    sshTarget: "prod-dsh",
    dshWebToken: " launch-token ",
  });
  assertEquals(saved, {
    id: "profile-1",
    name: "Production",
    sshTarget: "prod-dsh",
    remotePort: DEFAULT_REMOTE_PORT,
    dshWebToken: "launch-token",
  });
  assertEquals(JSON.parse(await Deno.readTextFile(filePath)).profiles, [saved]);

  const reopened = (await ProfileStore.open(filePath)).store;
  assertEquals(reopened.list(), [saved]);

  const cleared = await reopened.save({
    id: saved.id,
    name: saved.name,
    sshTarget: saved.sshTarget,
    remotePort: saved.remotePort,
    dshWebToken: " ",
  });
  assertEquals(cleared, {
    id: "profile-1",
    name: "Production",
    sshTarget: "prod-dsh",
    remotePort: DEFAULT_REMOTE_PORT,
  });
  assertEquals(JSON.parse(await Deno.readTextFile(filePath)).profiles, [cleared]);
});

Deno.test("ProfileStore persists the selected mode and last used profile", async () => {
  const filePath = await tempFile("servers.json");
  let nextId = 1;
  const { store } = await ProfileStore.open(filePath, { createId: () => `profile-${nextId++}` });
  const first = await store.save({ name: "First", sshTarget: "first" });
  const second = await store.save({ name: "Second", sshTarget: "second" });

  assertEquals(store.connectionMode(), "remote");
  await store.setConnectionMode("local");
  await store.markUsed(second.id);
  assertEquals(store.list(), [second, first]);

  const persisted = JSON.parse(await Deno.readTextFile(filePath));
  assertEquals(persisted.mode, "local");
  assertEquals(persisted.lastProfileId, second.id);

  const reopened = (await ProfileStore.open(filePath)).store;
  assertEquals(reopened.connectionMode(), "local");
  assertEquals(reopened.list(), [second, first]);
  await reopened.delete(second.id);
  assertEquals(reopened.list(), [first]);
  assertEquals(JSON.parse(await Deno.readTextFile(filePath)).lastProfileId, undefined);

  await assertRejects(() => reopened.setConnectionMode("invalid"), ProfileValidationError);
  await assertRejects(() => reopened.markUsed("missing"), ProfileValidationError);
});

Deno.test("ProfileStore opens version 1 files without saved preferences", async () => {
  const filePath = await tempFile("servers.json");
  await Deno.writeTextFile(filePath, JSON.stringify({ version: 1, profiles: [] }));

  const { store, recoveredBackup } = await ProfileStore.open(filePath);
  assertEquals(store.connectionMode(), "remote");
  assertEquals(store.list(), []);
  assertEquals(recoveredBackup, undefined);
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

Deno.test("ProfileStore opens version 1 profiles without DSH Web tokens", async () => {
  const filePath = await tempFile("servers.json");
  await Deno.writeTextFile(
    filePath,
    JSON.stringify({
      version: 1,
      mode: "remote",
      profiles: [{
        id: "profile-1",
        name: "Production",
        sshTarget: "prod-dsh",
        remotePort: 3080,
      }],
    }),
  );

  const { store, recoveredBackup } = await ProfileStore.open(filePath);
  assertEquals(recoveredBackup, undefined);
  assertEquals(store.list(), [{
    id: "profile-1",
    name: "Production",
    sshTarget: "prod-dsh",
    remotePort: 3080,
  }]);
});

for (
  const { name, profile } of [
    {
      name: "boolean port",
      profile: {
        id: "profile-1",
        name: "Production",
        sshTarget: "prod-dsh",
        remotePort: true,
      },
    },
    {
      name: "boolean DSH Web token",
      profile: {
        id: "profile-1",
        name: "Production",
        sshTarget: "prod-dsh",
        remotePort: 3080,
        dshWebToken: true,
      },
    },
  ]
) {
  Deno.test(`ProfileStore backs up config with ${name}`, async () => {
    const filePath = await tempFile("servers.json");
    await Deno.writeTextFile(
      filePath,
      JSON.stringify({
        version: 1,
        profiles: [profile],
      }),
    );

    const opened = await ProfileStore.open(filePath, {
      now: () => new Date("2025-01-02T03:04:05.000Z"),
    });

    assertEquals(opened.store.list(), []);
    assertEquals(opened.recoveredBackup, `${filePath}.invalid-2025-01-02T03-04-05.000Z`);
  });
}

function acceptsSaveInput(_input: Parameters<ProfileStore["save"]>[0]): void {}

// @ts-expect-error remotePort only accepts browser form text or numeric ports.
acceptsSaveInput({ name: "bad", sshTarget: "prod", remotePort: true });
// @ts-expect-error dshWebToken only accepts browser form text.
acceptsSaveInput({ name: "bad", sshTarget: "prod", dshWebToken: true });
