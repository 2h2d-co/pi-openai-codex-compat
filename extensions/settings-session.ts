import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingsField } from "./settings-menu.ts";
import {
  observedSetting,
  type SettingsSessionState,
  type SettingValue,
  type SettingValues,
} from "./settings-store.ts";

export type SettingsSessionContext = {
  sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getEntries">;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valid(field: SettingsField, value: unknown): value is SettingValue {
  if (field.choices.some((choice) => choice === value)) return true;
  const rule = field.number;
  return Boolean(
    rule &&
    typeof value === "number" &&
    Number.isFinite(value) &&
    (!rule.integer || Number.isInteger(value)) &&
    (rule.exclusiveMin ? value > rule.min : value >= rule.min) &&
    value <= rule.max,
  );
}

/** Session-wide preferences deliberately ignore tree position and copied fork entries. */
export function readSessionSettings(
  ctx: SettingsSessionContext,
  customType: string,
  fields: SettingsField[],
): { values: SettingValues; session: SettingsSessionState } {
  const entries = ctx.sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== customType) continue;
    const data: unknown = entry.data;
    if (
      object(data) &&
      typeof data["sessionId"] === "string" &&
      data["sessionId"] !== ctx.sessionManager.getSessionId()
    )
      continue;
    const fail = () => {
      throw new Error(`Invalid saved session settings (${customType}).`);
    };
    if (
      !object(data) ||
      data["sessionId"] !== ctx.sessionManager.getSessionId() ||
      data["version"] !== 1 ||
      !object(data["values"]) ||
      !object(data["changes"]) ||
      !object(data["observed"])
    )
      return fail();
    // Newer versions may remove a setting or narrow its values. Skip such fields so a session
    // saved by an older version still resumes; only a malformed record fails.
    const values: SettingValues = {};
    const session: SettingsSessionState = { changes: {} };
    for (const [id, value] of Object.entries(data["values"])) {
      const field = fields.find((candidate) => candidate.id === id);
      if (field && valid(field, value)) values[id] = value;
    }
    const observed: Record<string, [string, string]> = {};
    for (const [id, change] of Object.entries(data["changes"])) {
      if (!Array.isArray(change) || change.length > 1) return fail();
      const field = fields.find((candidate) => candidate.id === id);
      if (!field || !Object.hasOwn(values, id)) continue;
      const value: unknown = change[0];
      let next: SettingValue | undefined;
      if (change.length !== 0) {
        if (!valid(field, value)) continue;
        next = value;
      }
      const hashes = data["observed"][id];
      if (!Array.isArray(hashes) || hashes.length !== 2) return fail();
      const global: unknown = hashes[0];
      const project: unknown = hashes[1];
      if (
        typeof global !== "string" ||
        typeof project !== "string" ||
        !/^[a-f0-9]{64}$/.test(global) ||
        !/^[a-f0-9]{64}$/.test(project)
      )
        return fail();
      session.changes[id] = next;
      observed[id] = [global, project];
    }
    if (Object.keys(session.changes).length) {
      if (typeof data["file"] !== "string") return fail();
      session.baseline = {
        file: data["file"],
        observed,
        values: {},
        inherited: {},
        sources: {},
        global: { text: undefined, data: {} },
        project: { text: undefined, data: {} },
      };
    }
    return { values, session };
  }
  return { values: {}, session: { changes: {} } };
}

/** Store only known preferences and conflict hashes, never raw configuration documents. */
export function sessionSettingsEntry(
  sessionId: string,
  values: SettingValues,
  session: SettingsSessionState,
  locked: Record<string, string>,
) {
  const writable = Object.entries(values).filter(([id]) => !locked[id]);
  const changes = Object.entries(session.changes).filter(([id]) => !locked[id]);
  return {
    version: 1,
    sessionId,
    values: Object.fromEntries(writable),
    changes: Object.fromEntries(
      changes.map(([id, value]) => [id, value === undefined ? [] : [value]]),
    ),
    file: session.baseline?.file,
    observed: Object.fromEntries(
      changes.map(([id]) => {
        if (!session.baseline) throw new Error("Missing session settings conflict baseline.");
        return [id, observedSetting(session.baseline, id)];
      }),
    ),
  };
}
