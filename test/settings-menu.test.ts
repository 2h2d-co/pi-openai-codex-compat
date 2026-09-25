import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { getKeybindings, visibleWidth, CURSOR_MARKER } from "@earendil-works/pi-tui";
import { settingsMenu, waitForSettingsIdle } from "../extensions/settings-menu.ts";
import { SettingsStore, type SettingValues } from "../extensions/settings-store.ts";

async function fixture(t: TestContext, locked: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "settings-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "global.json");
  const project = join(root, "project.json");
  const resolve = (
    global: Record<string, unknown>,
    local: Record<string, unknown>,
  ): SettingValues => {
    const data = { enabled: false, budget: 8, percent: null, mode: "a", ...global, ...local };
    return {
      enabled: Boolean(data.enabled),
      budget: Number(data.budget),
      mode: String(data.mode),
      percent: data.percent === null ? null : Number(data.percent),
    };
  };
  const store = new SettingsStore(file, project, resolve, locked);
  const snapshot = await store.load();
  let applied: SettingValues | undefined;
  let closed = 0;
  let allowed = true;
  let failApply = false;
  let waiting: (() => Promise<void>) | undefined;
  let version = "";
  let output: string[] = [];
  const styles: { color: string; text: string }[] = [];
  const terminal = { rows: 30, columns: 120 };
  const keys = getKeybindings();
  const originalBindings = keys.getUserBindings();
  t.after(() => keys.setUserBindings(originalBindings));
  const component = settingsMenu({
    title: "Provider Settings",
    store,
    snapshot,
    fields: [
      {
        id: "enabled",
        label: "Native feature",
        description: "A searchable boolean switch.",
        choices: [false, true],
      },
      {
        id: "budget",
        label: "Budget tokens",
        description: "Whole token budget.",
        choices: [8, 16],
        number: { min: 1, max: 200, integer: true, unit: "tokens" },
      },
      {
        id: "percent",
        label: "Threshold",
        description: "Fractional percentage.",
        choices: [null, 75],
        number: { min: 0, max: 100, exclusiveMin: true, unit: "%" },
      },
      { id: "mode", label: "Mode", description: "An enum.", choices: ["a", "b"] },
    ],
    status: () => "Provider applicability",
    prepare: (signal) => waitForSettingsIdle(waiting ?? (async () => {}), signal),
    guard: () => {
      if (!allowed) throw new Error("Runtime is busy.");
    },
    apply: (values) => {
      if (failApply) throw new Error("Apply failed");
      applied = values;
    },
  })(
    {
      terminal,
      requestRender: () => {
        output = component.render(terminal.columns);
      },
    },
    {
      fg: (color, text) => {
        styles.push({ color, text });
        return `${version}${text}`;
      },
      bold: (text) => text,
    },
    keys,
    () => {
      closed++;
    },
  );
  output = component.render(terminal.columns);
  const press = (...inputs: string[]) => {
    for (const input of inputs) {
      component.handleInput?.(input);
      output = component.render(terminal.columns);
    }
  };
  const until = async (text: string) => {
    for (let count = 0; count < 200 && !output.join("\n").includes(text); count++)
      await setTimeout(10);
    assert.ok(output.join("\n").includes(text), output.join("\n"));
  };
  return {
    root,
    file,
    project,
    store,
    snapshot,
    component,
    press,
    until,
    keys,
    terminal,
    styles,
    output: () => output.join("\n"),
    applied: () => applied,
    closed: () => closed,
    allow: (value: boolean) => {
      allowed = value;
    },
    failApply: (value: boolean) => {
      failApply = value;
    },
    wait: (value: () => Promise<void>) => {
      waiting = value;
    },
    theme: () => {
      version = "new:";
      component.invalidate();
    },
  };
}

test("filtered Enter stages changes, Ctrl+S persists only dirty fields, Escape discards", async (t) => {
  const f = await fixture(t);
  f.press("native feature", "\r");
  assert.equal(f.applied(), undefined);
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
  f.press("\u0013");
  await f.until("Saved and applied");
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), { enabled: true });
  assert.equal(f.applied()?.["enabled"], true);
  f.press("\r", "\u001b");
  assert.equal(f.closed(), 1);
  assert.equal(f.applied()?.["enabled"], true);
});

test("no-op save and close creates no files; toggling back clears dirty state", async (t) => {
  const f = await fixture(t);
  f.press("\r", "\r");
  assert.match(f.output(), /No unsaved/);
  f.press("\u0013", "\t", "\r");
  assert.equal(f.closed(), 1);
  assert.deepEqual(await readdir(f.root), []);
});

test("encoded Space, remapped confirm, search spaces, focus, and themes", async (t) => {
  const f = await fixture(t);
  f.press("\u001b[32u");
  assert.match(f.output(), /on \*/);
  f.press("native", " ", "feature");
  assert.match(f.output(), /native feature/);
  f.keys.setUserBindings({ "tui.select.confirm": "ctrl+y" });
  f.press("\u0019");
  assert.match(f.output(), /No unsaved/);
  assert.match(f.output(), /ctrl\+y change/);
  if ("focused" in f.component) f.component.focused = true;
  assert.ok(f.component.render(120).join("\n").includes(CURSOR_MARKER));
  f.theme();
  assert.match(f.component.render(120)[0] ?? "", /new:Provider Settings/);
  for (const width of [20, 40, 80, 120]) {
    for (const rows of [12, 18, 30]) {
      f.terminal.rows = rows;
      const lines = f.component.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(lines.length <= rows, `${rows}: ${lines.length}`);
      assert.match(lines.join("\n"), /Ctrl\+S save/);
      assert.match(lines.join("\n"), /escape(?:\/ctrl\+c)? discard/);
    }
  }
  f.press("\u001b");
});

test("labels precede aligned values and filtering or draft markers do not move the column", async (t) => {
  const f = await fixture(t);
  for (const width of [20, 40, 80, 120]) {
    f.terminal.columns = width;
    const lines = f.component.render(width);
    const columns = [
      ["Native feature", "off"],
      ["Budget tokens", "8"],
      ["Threshold", "null"],
      ["Mode", "a"],
    ].map(([label, value]) => {
      assert.ok(label && value);
      const row = lines.find((line) => line.includes(label.slice(0, 5)) && line.endsWith(value));
      assert.ok(row);
      return visibleWidth(row.slice(0, -value.length));
    });
    assert.ok(columns.every((column) => column === columns[0]));
    f.press("native");
    const filtered = f
      .output()
      .split("\n")
      .find((line) => line.includes("Nativ"));
    assert.ok(filtered);
    assert.ok(filtered.endsWith("off"));
    assert.equal(visibleWidth(filtered.slice(0, -3)), columns[0]);
    f.press("\r");
    const dirty = f
      .output()
      .split("\n")
      .find((line) => line.includes("Nativ"));
    assert.ok(dirty);
    assert.ok(dirty.endsWith("on *"));
    assert.equal(visibleWidth(dirty.slice(0, -4)), columns[0]);
    f.press("\r", "\u0015");
  }
  f.press("\u001b");
});

test("search placeholder uses muted theme styling and entered text does not", async (t) => {
  const f = await fixture(t);
  f.styles.length = 0;
  f.component.render(120);
  assert.equal(
    f.styles
      .filter(({ color }) => color === "muted")
      .map(({ text }) => text)
      .join("")
      .includes("Search settings"),
    true,
  );
  f.styles.length = 0;
  f.press("native");
  assert.equal(
    f.styles.some(({ text }) => text.includes("Search settings") || text === "native"),
    false,
  );
  assert.match(f.output(), /> native/);
  f.press("\u001b");
});

test("numeric editors validate full ranges, keep errors open, and cancel locally", async (t) => {
  const f = await fixture(t);
  f.press("budget", "\r", "\u001b[B", "\u001b[B", "\r", "\u0015", "201", "\r");
  assert.match(f.output(), /≤ 200/);
  f.press("\u0013");
  assert.equal(f.applied(), undefined);
  f.press("\u0015", "101", "\r", "\u0013");
  await f.until("Saved and applied");
  assert.equal(f.applied()?.["budget"], 101);
  f.press("\r", "\u001b", "\u001b");
  assert.equal(f.closed(), 1);
});

test("fractional percentages, bracketed paste, and empty results", async (t) => {
  const f = await fixture(t);
  f.press(
    "\u001b[200~threshold\u001b[201~",
    "\r",
    "\u001b[B",
    "\u001b[B",
    "\r",
    "\u0015",
    "87.5",
    "\r",
    "\u0013",
  );
  await f.until("Saved and applied");
  assert.equal(f.applied()?.["percent"], 87.5);
  f.press("\u0015", "no matches");
  assert.match(f.output(), /No matching/);
  f.press("\r");
  assert.equal(f.closed(), 0);
  f.press("\u001b");
});

test("environment rows remain locked and no override is written", async (t) => {
  const f = await fixture(t, { enabled: "EXAMPLE_ENABLED" });
  f.press("\r", " ", "\u0013");
  assert.equal(f.applied(), undefined);
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
  f.press("\u001b");
});

test("cancel idle wait and disposal never apply or save a stale menu", async (t) => {
  const f = await fixture(t);
  let release: () => void = () => {};
  f.wait(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  f.press("\r", "\u0013", "\u001b");
  await f.until("Save cancelled");
  release();
  assert.equal(f.applied(), undefined);
  f.press("\u0013");
  f.component.dispose?.();
  release();
  await setTimeout(20);
  assert.equal(f.applied(), undefined);
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
});

test("failed guards preserve drafts; application failure is distinct from disk success", async (t) => {
  const f = await fixture(t);
  f.allow(false);
  f.press("\r", "\u0013");
  await f.until("Runtime is busy");
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
  f.allow(true);
  f.failApply(true);
  f.press("\u0013");
  await f.until("Saved to disk; session application failed");
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), { enabled: true });
  f.failApply(false);
  f.press("\u0013");
  await f.until("Saved and applied");
  assert.equal(f.applied()?.["enabled"], true);
  f.press("\u001b");
});

test("store merges unrelated edits, rejects same-field conflicts, and preserves unknown keys", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify({ budget: 99, future: { preserve: true } }));
  const signal = new AbortController().signal;
  const saved = await f.store.save(f.snapshot, { enabled: true }, signal, () => {});
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), {
    budget: 99,
    future: { preserve: true },
    enabled: true,
  });
  assert.equal(saved.values["budget"], 99);
  await writeFile(f.file, JSON.stringify({ enabled: false }));
  await assert.rejects(
    f.store.save(saved, { enabled: false }, signal, () => {}),
    /changed on disk/,
  );
});

test("project saves retain inheritance, remove overrides, and reject scope changes", async (t) => {
  const f = await fixture(t);
  const signal = new AbortController().signal;
  await writeFile(f.file, JSON.stringify({ budget: 90 }));
  await writeFile(f.project, JSON.stringify({ enabled: true }));
  await assert.rejects(
    f.store.save(f.snapshot, { budget: 10 }, signal, () => {}),
    /scope changed/,
  );
  const current = await f.store.load();
  const saved = await f.store.save(current, { enabled: undefined }, signal, () => {});
  assert.deepEqual(JSON.parse(await readFile(f.project, "utf8")), {});
  assert.equal(saved.values["budget"], 90);
  assert.equal(saved.values["enabled"], false);
  const untrusted = new SettingsStore(f.file, undefined, f.store.resolve);
  assert.equal((await untrusted.load()).file, f.file);
});

test("invalid JSON, write failures, and concurrent cooperating writers preserve data", async (t) => {
  const f = await fixture(t);
  const signal = new AbortController().signal;
  await writeFile(f.file, "{ invalid");
  await assert.rejects(f.store.load(), /Invalid settings/);
  assert.equal(await readFile(f.file, "utf8"), "{ invalid");
  await writeFile(f.file, "{}");
  const current = await f.store.load();
  await Promise.all([
    f.store.save(current, { enabled: true }, signal, () => {}),
    f.store.save(current, { budget: 88 }, signal, () => {}),
  ]);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), { enabled: true, budget: 88 });
  const bad = new SettingsStore(join(f.root, "directory"), undefined, f.store.resolve);
  await mkdir(bad.globalFile);
  await assert.rejects(bad.load(), /Cannot read/);
});

test("mouse activation stages the same edit and explicit Save and close commits it", async (t) => {
  const f = await fixture(t);
  const click = (label: string) => {
    const lines = f.component.render(120);
    const y = lines.findIndex((line) => line.includes(label));
    assert.ok(y >= 0);
    for (const type of ["press", "click"] as const) {
      f.component.handleMouse?.({
        type,
        button: "left",
        x: 4,
        y,
        screenX: 4,
        screenY: y,
        width: 120,
        height: lines.length,
        shift: false,
        alt: false,
        ctrl: false,
      });
    }
  };
  click("Native feature");
  assert.equal(f.applied(), undefined);
  assert.match(f.output(), /on \*/);
  click("Save and close");
  for (let attempt = 0; attempt < 200 && f.closed() === 0; attempt++) await setTimeout(10);
  assert.equal(f.closed(), 1);
  assert.equal(f.applied()?.["enabled"], true);
});

test("reopening observes external values without copying untouched defaults", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify({ budget: 123 }));
  const reopened = await f.store.load();
  assert.equal(reopened.values["budget"], 123);
  await f.store.save(reopened, { enabled: true }, new AbortController().signal, () => {});
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), { budget: 123, enabled: true });
});

test("full details and errors stay reachable in short terminals", async (t) => {
  const f = await fixture(t);
  f.terminal.rows = 12;
  f.terminal.columns = 40;
  f.press("\u001bOP");
  const views: string[] = [];
  for (let index = 0; index < 8; index++) {
    const lines = f.component.render(40);
    assert.ok(lines.length <= 12);
    assert.ok(lines.every((line) => visibleWidth(line) <= 40));
    views.push(...lines);
    f.component.handleInput?.("\u001b[6~");
  }
  assert.match(views.join("\n"), /Source: default/);
  f.press("\u001b");
  assert.equal(f.closed(), 0);
  f.press("\u001b");
  assert.equal(f.closed(), 1);
});

test("repeated save is coalesced and save-time file changes are not overwritten", async (t) => {
  const f = await fixture(t);
  f.press("\r", "\u0013", "\u0013");
  await f.until("Saved and applied");
  assert.deepEqual(await readdir(f.root), ["global.json"]);
  const baseline = await f.store.load();
  await writeFile(f.file, JSON.stringify({ enabled: true, mode: "b" }));
  await assert.rejects(
    f.store.save(baseline, { mode: "a" }, new AbortController().signal, () => {}),
    /changed on disk/,
  );
  assert.equal((await f.store.load()).values["mode"], "b");
});
