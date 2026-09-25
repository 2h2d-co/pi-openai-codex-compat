import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readSessionSettings, sessionSettingsEntry } from "../extensions/settings-session.ts";
import { sessionBaseline, SettingsStore } from "../extensions/settings-store.ts";
import type { SettingsField } from "../extensions/settings-menu.ts";

const fields: SettingsField[] = [
  { id: "enabled", label: "Enabled", choices: [false, true], description: "" },
  {
    id: "budget",
    label: "Budget",
    choices: [8, 16],
    description: "",
    number: { min: 1, max: 200, integer: true, unit: "tokens" },
  },
];
const type = "test:settings";

test("session preferences survive disk resume and branches without leaking to other sessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "settings-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const file = join(root, "global.json");
  await writeFile(file, JSON.stringify({ enabled: false, budget: 16, future: "private metadata" }));
  const store = new SettingsStore(file, undefined, (global) => ({
    enabled: Boolean(global["enabled"]),
    budget: Number(global["budget"] ?? 8),
  }));
  const baseline = await store.load();
  const record = sessionSettingsEntry(
    manager.getSessionId(),
    { enabled: true, budget: 8 },
    {
      changes: { enabled: true, budget: undefined },
      baseline,
    },
    {},
  );
  manager.appendCustomEntry(type, record);
  assert.ok(!JSON.stringify(record).includes("private metadata"));
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  const resumed = SessionManager.open(sessionFile);
  resumed.resetLeaf();
  const state = readSessionSettings({ sessionManager: resumed }, type, fields);
  assert.deepEqual(state.values, { enabled: true, budget: 8 });
  assert.equal(Object.hasOwn(state.session.changes, "budget"), true);
  assert.equal(state.session.changes["budget"], undefined);
  assert.equal(resumed.buildSessionContext().messages.length, 0);
  const other = SessionManager.inMemory(root);
  other.appendCustomEntry(type, record);
  assert.deepEqual(readSessionSettings({ sessionManager: other }, type, fields).values, {});
  // Explicit preferences are restored even after file edits, but stale writes stay blocked.
  await writeFile(file, JSON.stringify({ enabled: true, budget: 16 }));
  await assert.rejects(
    store.save(
      sessionBaseline(await store.load(), state.session),
      state.session.changes,
      new AbortController().signal,
      () => {},
    ),
    /changed on disk/,
  );
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { enabled: true, budget: 16 });
  assert.equal(
    readSessionSettings({ sessionManager: SessionManager.open(sessionFile) }, type, fields).values[
      "enabled"
    ],
    true,
  );
});

test("latest session record clears pending saves and excludes environment-controlled fields", () => {
  const manager = SessionManager.inMemory("/synthetic");
  manager.appendCustomEntry(
    type,
    sessionSettingsEntry(manager.getSessionId(), { enabled: true, budget: 8 }, { changes: {} }, {}),
  );
  manager.appendCustomEntry(
    type,
    sessionSettingsEntry(
      manager.getSessionId(),
      { enabled: false, budget: 16 },
      { changes: {} },
      { enabled: "TEST_ENABLED" },
    ),
  );
  assert.deepEqual(readSessionSettings({ sessionManager: manager }, type, fields), {
    values: { budget: 16 },
    session: { changes: {} },
  });
});

test("invalid session records fail visibly instead of silently selecting file defaults", () => {
  for (const values of [
    { enabled: "invalid" },
    { budget: 201 },
    { budget: 1.5 },
    { unknown: true },
  ]) {
    const manager = SessionManager.inMemory("/synthetic");
    manager.appendCustomEntry(type, {
      version: 1,
      sessionId: manager.getSessionId(),
      values,
      changes: {},
      observed: {},
    });
    assert.throws(
      () => readSessionSettings({ sessionManager: manager }, type, fields),
      /Invalid saved session settings/,
    );
  }
});

test("restored save targets cannot direct writes outside configured paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "settings-target-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SettingsStore(join(root, "global.json"), undefined, () => ({ enabled: false }));
  const baseline = await store.load();
  await assert.rejects(
    store.save(
      { ...baseline, file: join(root, "untrusted.json") },
      { enabled: true },
      new AbortController().signal,
      () => {},
    ),
    /scope changed/,
  );
  await assert.rejects(readFile(join(root, "untrusted.json")), { code: "ENOENT" });
});
