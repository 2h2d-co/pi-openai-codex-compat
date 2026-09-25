import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  Input,
  Key,
  matchesKey,
  SelectList,
  ScrollView,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type SelectItem,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  SettingsStore,
  sessionBaseline,
  type SettingsSessionState,
  type SettingChanges,
  type SettingsSnapshot,
  type SettingValue,
  type SettingValues,
} from "./settings-store.ts";
type MenuFocus = "search" | "results" | "actions";
function isSearchText(data: string): boolean {
  if (decodeKittyPrintable(data) !== undefined || data.includes("\u001b[200~")) return true;
  for (let index = 0; index < data.length; index++) {
    const code = data.charCodeAt(index);
    if (code < 32 || code === 127 || (code >= 128 && code <= 159)) return false;
  }
  return data.length > 0;
}

// Keep this provider-independent contract aligned with pi-anthropic-compat.
export type SettingsField = {
  id: string;
  label: string;
  description: string;
  choices: SettingValue[];
  number?: { min: number; max: number; integer?: boolean; exclusiveMin?: boolean; unit: string };
  format?: (value: SettingValue) => string;
};
export type SettingsMenuOptions = {
  title: string;
  store: SettingsStore;
  snapshot: SettingsSnapshot;
  current: SettingValues;
  session: SettingsSessionState;
  fields: SettingsField[];
  status: (values: SettingValues) => string;
  prepare: (signal: AbortSignal) => Promise<void>;
  guard: (values: SettingValues) => void;
  apply: (values: SettingValues, session: SettingsSessionState) => void;
};
export type SettingsMenuFactory<T> = (
  tui: Pick<TUI, "requestRender"> & { terminal?: { rows: number } },
  theme: Pick<Theme, "fg" | "bold">,
  keys: Pick<KeybindingsManager, "matches" | "getKeys">,
  done: (value: T) => void,
) => Component & { dispose?: () => void };

export function settingsMenu(options: SettingsMenuOptions): SettingsMenuFactory<undefined> {
  return (tui, theme, keys, done) => {
    let baseline = sessionBaseline(options.snapshot, options.session);
    let active = { ...options.current };
    let draft = { ...active };
    let changes: SettingChanges = { ...options.session.changes };
    let notice = Object.keys(changes).length
      ? "Session settings shown. Not saved to configuration files."
      : "Draft changes apply only when applied or saved.";
    let failed = false;
    let pendingApply = false;
    let disposed = false;
    let busy = false;
    let operation: "apply" | "save" = "save";
    let saveAbort: AbortController | undefined;
    let focused = false;
    let focus: MenuFocus = "results";
    let selectedId = options.fields[0]?.id;
    let child:
      | {
          field: SettingsField;
          list?: SelectList;
          input?: Input;
          choices?: SelectItem[];
          visible?: number;
        }
      | undefined;
    const search = new Input({
      placeholder: "Search settings",
      placeholderStyle: (text) => theme.fg("muted", text),
    });
    const listTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("dim", text),
    };
    const focusTheme = (area: MenuFocus) => ({
      ...listTheme,
      selectedPrefix: (text: string) => theme.fg(child || focus === area ? "accent" : "dim", text),
      selectedText: (text: string) => theme.fg(child || focus === area ? "accent" : "text", text),
    });
    let list = new SelectList([], 1, focusTheme("results"));
    let listSignature = "";
    let details: ScrollView | undefined;
    const actions = new SelectList(
      [
        { value: "apply", label: "Apply to session" },
        { value: "save", label: "Save and close" },
        { value: "inherit", label: "Use inherited value for selected setting" },
        { value: "details", label: "Details, errors, and save target" },
      ],
      4,
      focusTheme("actions"),
    );
    let zones: { component: Component; top: number; height: number; focus: MenuFocus }[] = [];
    const draftChanged = (id: string) =>
      draft[id] !== active[id] ||
      Object.hasOwn(changes, id) !== Object.hasOwn(options.session.changes, id) ||
      changes[id] !== options.session.changes[id];
    const dirty = () => options.fields.filter((field) => draftChanged(field.id)).length;
    const source = (id: string) =>
      options.store.locked[id]
        ? baseline.sources[id]
        : draftChanged(id)
          ? "draft"
          : Object.hasOwn(options.session.changes, id) || draft[id] !== baseline.values[id]
            ? "session"
            : baseline.sources[id];
    const fieldValue = (field: SettingsField, value: SettingValue | undefined): string =>
      value === undefined
        ? ""
        : (field.format?.(value) ??
          (typeof value === "boolean" ? (value ? "on" : "off") : String(value)));
    const keyName = (id: Parameters<typeof keys.getKeys>[0], compact = false) => {
      const bindings = keys.getKeys(id);
      return (compact ? bindings[0] : bindings.join("/")) || "unbound";
    };
    const updateFocus = () => {
      search.focused = focused && focus === "search" && !child && !details;
      if (child?.input) child.input.focused = focused;
    };
    const close = () => {
      if (disposed) return;
      disposed = true;
      saveAbort?.abort();
      done(undefined);
    };
    const change = (field: SettingsField, value: SettingValue | undefined) => {
      if (options.store.locked[field.id]) return;
      const target =
        baseline.file === options.store.globalFile ? baseline.global : baseline.project;
      if (value === undefined) {
        if (Object.hasOwn(target.data, field.id)) changes[field.id] = undefined;
        else delete changes[field.id];
        const inherited = baseline.inherited[field.id];
        if (inherited !== undefined) draft[field.id] = inherited;
      } else {
        draft[field.id] = value;
        if (value === active[field.id]) {
          if (Object.hasOwn(options.session.changes, field.id))
            changes[field.id] = options.session.changes[field.id];
          else delete changes[field.id];
        } else if (value === baseline.values[field.id]) delete changes[field.id];
        else changes[field.id] = value;
      }
      failed = false;
      notice = dirty()
        ? `${dirty()} draft change(s). Not applied.`
        : Object.keys(changes).length
          ? "No draft changes. Session settings are not saved to configuration files."
          : "No unsaved changes.";
      child = undefined;
      updateFocus();
    };
    const activate = (field: SettingsField) => {
      if (options.store.locked[field.id]) {
        notice = `Locked by ${options.store.locked[field.id]}.`;
        return;
      }
      const current = draft[field.id];
      if (current === undefined) return;
      if (typeof current === "boolean") {
        change(field, !current);
        return;
      }
      const choices: SelectItem[] = field.choices.map((value, index) => ({
        value: String(index),
        label: fieldValue(field, value),
      }));
      if (field.number) choices.push({ value: "custom", label: "Custom value…" });
      choices.push({
        value: "inherit",
        label: `Use inherited value (${fieldValue(field, baseline.inherited[field.id])})`,
      });
      const picker = new SelectList(choices, 6, listTheme);
      const index = field.choices.indexOf(current);
      picker.setSelectedIndex(index < 0 ? field.choices.length : index);
      picker.onSelect = (item) => {
        if (item.value === "custom") {
          const input = new Input();
          input.handleInput(`\u001b[200~${current === null ? "" : String(current)}\u001b[201~`);
          child = { field, input };
          updateFocus();
        } else {
          change(field, item.value === "inherit" ? undefined : field.choices[Number(item.value)]);
        }
      };
      child = { field, list: picker, choices };
      notice = "Choose a value. Changes remain a draft.";
      updateFocus();
    };
    const commit = async (mode: "apply" | "save", closeAfter = false) => {
      if (busy || disposed) return;
      if (!dirty() && !pendingApply && (mode === "apply" || !Object.keys(changes).length)) {
        notice = mode === "apply" ? "No draft changes to apply." : "No changes to save.";
        if (closeAfter) close();
        return;
      }
      busy = true;
      operation = mode;
      failed = false;
      saveAbort = new AbortController();
      const { signal } = saveAbort;
      notice =
        mode === "save" ? "Waiting for idle, then saving…" : "Waiting for idle, then applying…";
      tui.requestRender();
      try {
        await options.prepare(signal);
        signal.throwIfAborted();
        if (mode === "save") {
          baseline = await options.store.save(baseline, changes, signal, options.guard);
          draft = { ...baseline.values };
          changes = {};
          pendingApply = true;
        }
        signal.throwIfAborted();
        options.guard(draft);
        options.apply(
          { ...draft },
          {
            changes: { ...changes },
            ...(Object.keys(changes).length ? { baseline } : {}),
          },
        );
        active = { ...draft };
        options.session.changes = { ...changes };
        if (Object.keys(changes).length) options.session.baseline = baseline;
        else delete options.session.baseline;
        pendingApply = false;
        notice =
          mode === "save"
            ? "Saved and applied."
            : "Applied to session. Configuration files unchanged.";
        if (closeAfter) close();
      } catch (error) {
        failed = true;
        notice = pendingApply
          ? "Saved to disk; session application failed. Ctrl+S retries; reopen to review."
          : signal.aborted
            ? `${mode === "save" ? "Save" : "Application"} cancelled. Draft retained.`
            : error instanceof Error
              ? error.message
              : "Could not update settings.";
      } finally {
        busy = false;
        if (!disposed) tui.requestRender();
      }
    };
    const saveFailed = (error: unknown) => {
      busy = false;
      failed = true;
      notice = error instanceof Error ? error.message : "Could not finish saving.";
      if (!disposed) tui.requestRender();
    };
    const showDetails = () => {
      const field = options.fields.find((entry) => entry.id === selectedId);
      const content = [
        notice,
        `Save target: ${baseline.file}`,
        options.status(draft),
        ...(field
          ? [
              `${field.label}: ${fieldValue(field, draft[field.id])}`,
              `Source: ${source(field.id)}`,
              ...(draft[field.id] !== baseline.values[field.id]
                ? [`Saved value: ${fieldValue(field, baseline.values[field.id])}`]
                : []),
              field.description,
            ]
          : []),
      ];
      details = new ScrollView(new Text(content.join("\n\n"), 0, 0), { scrollbar: "hidden" });
      search.focused = false;
    };
    actions.onSelect = (item) => {
      if (item.value === "apply") commit("apply").catch(saveFailed);
      else if (item.value === "save") commit("save", true).catch(saveFailed);
      else if (item.value === "details") showDetails();
      else {
        const field = options.fields.find((entry) => entry.id === selectedId);
        if (field) change(field, undefined);
      }
    };
    const selectedField = () => options.fields.find((field) => field.id === selectedId);
    const confirmNumber = () => {
      if (!child?.input || !child.field.number) return;
      const raw = child.input.getValue().trim();
      const value = Number(raw);
      const rule = child.field.number;
      if (
        !/^\d+(?:\.\d+)?$/.test(raw) ||
        !Number.isFinite(value) ||
        (rule.integer && !Number.isInteger(value)) ||
        (rule.exclusiveMin ? value <= rule.min : value < rule.min) ||
        value > rule.max
      ) {
        failed = true;
        notice = `Enter ${rule.integer ? "an integer" : "a number"} ${rule.exclusiveMin ? ">" : "≥"} ${rule.min} and ≤ ${rule.max} ${rule.unit}.`;
        return;
      }
      change(child.field, value);
    };
    const component: Component & Focusable & { dispose: () => void } = {
      get focused() {
        return focused;
      },
      set focused(value) {
        focused = value;
        updateFocus();
      },
      dispose() {
        disposed = true;
        saveAbort?.abort();
      },
      invalidate() {
        search.invalidate();
        list.invalidate();
        child?.input?.invalidate();
        child?.list?.invalidate();
      },
      render(width) {
        zones = [];
        const lines: string[] = [];
        const height = Math.max(9, (tui.terminal?.rows ?? 24) - 3);
        const text = (value: string, color: "accent" | "dim" | "error" | "muted" = "dim") =>
          lines.push(truncateToWidth(theme.fg(color, value), width));
        const zone = (part: Component, target: typeof focus) => {
          const rendered = part.render(width);
          zones.push({
            component: part,
            top: lines.length,
            height: rendered.length,
            focus: target,
          });
          lines.push(...rendered);
        };
        text(options.title, "accent");
        if (details) {
          const content = details.render(width);
          details.updateLayout(content.length, height - 2, () => tui.requestRender());
          lines.push(...content.slice(details.scrollTop, details.scrollTop + height - 2));
          text(
            `${keyName("tui.select.up")}/${keyName("tui.select.down")} scroll · ${keyName("tui.select.cancel")} back`,
          );
          return lines.map((line) => truncateToWidth(line, width));
        }
        if (height > 11) text(`Save to: ${baseline.file}`);
        const statusLines = new Text(notice, 0, 0).render(width);
        const statusBudget = Math.max(1, Math.min(statusLines.length, height - 9));
        for (const line of statusLines.slice(0, statusBudget)) text(line, failed ? "error" : "dim");
        if (child) {
          text(`${child.field.label}: ${fieldValue(child.field, draft[child.field.id])}`, "accent");
          if (child.field.number) {
            const rule = child.field.number;
            text(
              `${rule.exclusiveMin ? ">" : "≥"} ${rule.min} to ${rule.max} ${rule.unit}${rule.integer ? "; whole numbers" : ""}`,
            );
          }
          const visible = Math.max(1, height - lines.length - 2);
          if (child.list && child.choices && child.visible !== visible) {
            const previous = child.list;
            const selected = previous.getSelectedItem()?.value;
            child.list = new SelectList(child.choices, visible, listTheme);
            child.list.setSelectedIndex(
              Math.max(
                0,
                child.choices.findIndex((item) => item.value === selected),
              ),
            );
            if (previous.onSelect) child.list.onSelect = previous.onSelect;
            child.visible = visible;
          }
          const editor = child.input ?? child.list;
          if (editor) zone(editor, "results");
          text(`${keyName("tui.select.confirm")} select · ${keyName("tui.select.cancel")} back`);
        } else {
          const hint = `${keyName("tui.select.confirm")} ${focus === "actions" ? "select" : "change"} · Space ${focus === "search" ? "search" : "select"} · ${keyName("tui.input.tab")} focus · Ctrl+S save · ${keyName("tui.select.cancel")} discard · F1 details`;
          const hints = busy
            ? [`${keyName("tui.select.cancel", true)} cancel ${operation}`]
            : visibleWidth(hint) <= width
              ? [hint]
              : width >= 40
                ? [
                    `${keyName("tui.select.confirm", true)} ${focus === "actions" ? "select" : "change"} · ${keyName("tui.input.tab", true)} focus`,
                    `Ctrl+S save · ${keyName("tui.select.cancel", true)} discard`,
                  ]
                : ["Ctrl+S save", `${keyName("tui.select.cancel", true)} discard`];
          const footerRows = 4 + hints.length;
          // Reserve search, up to three settings, a scroll indicator, and two
          // detail rows before spending the remaining height on five section gaps.
          const minimumContentRows = 1 + Math.min(3, options.fields.length) + 1 + 2;
          const gap = height - lines.length - footerRows - minimumContentRows >= 5 ? 1 : 0;
          if (gap) lines.push("");
          zone(search, "search");
          if (gap) lines.push("");
          const query = search.getValue().toLocaleLowerCase().trim().split(/\s+/);
          const fields = options.fields.filter((field) => {
            const content = `${field.label} ${field.id} ${field.description}`.toLocaleLowerCase();
            return query.every((word) => content.includes(word));
          });
          // SelectList reserves two columns for its cursor and two for its right margin.
          // Measure every field, not only matches, so filtering cannot move the value column.
          const contentWidth = Math.max(1, width - 4);
          const widestLabel = Math.max(...options.fields.map((field) => visibleWidth(field.label)));
          const widestValue = Math.max(
            ...options.fields.map((field) => {
              const values = [
                ...field.choices,
                draft[field.id] ?? null,
                ...(field.number ? [field.number.min, field.number.max] : []),
              ];
              return (
                Math.max(...values.map((value) => visibleWidth(fieldValue(field, value)))) +
                (options.store.locked[field.id] ? 6 : 2)
              );
            }),
          );
          const labelWidth = Math.min(
            widestLabel,
            Math.max(1, contentWidth - 2 - Math.min(widestValue, Math.floor(contentWidth / 2))),
          );
          const items = fields.map((field) => {
            const label = truncateToWidth(field.label, labelWidth);
            const value = `${fieldValue(field, draft[field.id])}${draftChanged(field.id) ? " *" : source(field.id) === "session" ? " ~" : ""}${options.store.locked[field.id] ? " (env)" : ""}`;
            return {
              value: field.id,
              label: `${label}${" ".repeat(labelWidth - visibleWidth(label) + 2)}${truncateToWidth(value, Math.max(1, contentWidth - labelWidth - 2))}`,
            };
          });
          const activeId = list.getSelectedItem()?.value ?? selectedId;
          const visible = Math.max(1, height - lines.length - footerRows - 2 - 3 * gap);
          const signature = JSON.stringify([items, visible]);
          if (signature !== listSignature) {
            listSignature = signature;
            list = new SelectList(items, visible, focusTheme("results"), {
              maxPrimaryColumnWidth: 1000,
            });
            list.setSelectedIndex(
              Math.max(
                0,
                items.findIndex((item) => item.value === activeId),
              ),
            );
          }
          selectedId = list.getSelectedItem()?.value;
          list.onSelect = (item) => {
            const field = options.fields.find((entry) => entry.id === item.value);
            if (field) activate(field);
          };
          list.onSelectionChange = (item) => {
            selectedId = item.value;
          };
          zone(list, "results");
          if (gap) lines.push("");
          const field = selectedField();
          if (height - lines.length > footerRows + 2 * gap) {
            text(
              field ? `${source(field.id)} · ${field.description}` : "No matching settings.",
              "muted",
            );
          }
          if (height - lines.length > footerRows + 2 * gap) text(options.status(draft), "muted");
          if (gap) lines.push("");
          zone(actions, "actions");
          if (gap) lines.push("");
          for (const line of hints) text(line);
        }
        return lines.map((line) => truncateToWidth(line, width));
      },
      handleInput(data) {
        if (disposed) return;
        if (busy) {
          if (keys.matches(data, "tui.select.cancel")) saveAbort?.abort();
          return;
        }
        if (details) {
          if (keys.matches(data, "tui.select.cancel")) {
            details = undefined;
            updateFocus();
          } else if (keys.matches(data, "tui.select.up")) details.scrollBy(-1);
          else if (keys.matches(data, "tui.select.down")) details.scrollBy(1);
          else if (keys.matches(data, "tui.select.pageUp"))
            details.scrollBy(-details.viewportHeight);
          else if (keys.matches(data, "tui.select.pageDown"))
            details.scrollBy(details.viewportHeight);
          tui.requestRender();
          return;
        }
        if (!child && matchesKey(data, "f1")) {
          showDetails();
          tui.requestRender();
          return;
        }
        if (keys.matches(data, "tui.select.cancel")) {
          if (child) {
            child = undefined;
            failed = false;
            notice = "Field edit cancelled.";
            updateFocus();
          } else close();
        } else if (child) {
          if (matchesKey(data, Key.ctrl("s"))) return;
          if (keys.matches(data, "tui.select.confirm")) {
            if (child.input) confirmNumber();
            else {
              const item = child.list?.getSelectedItem();
              if (item) child.list?.onSelect?.(item);
            }
          } else if (child.input) child.input.handleInput(data);
          else if (matchesKey(data, Key.space)) {
            const item = child.list?.getSelectedItem();
            if (item) child.list?.onSelect?.(item);
          } else child.list?.handleInput(data);
        } else if (matchesKey(data, Key.ctrl("s"))) {
          commit("save").catch(saveFailed);
        } else if (keys.matches(data, "tui.input.tab") || matchesKey(data, Key.shift("tab"))) {
          const order = ["search", "results", "actions"] as const;
          focus =
            order[(order.indexOf(focus) + (matchesKey(data, Key.shift("tab")) ? 2 : 1)) % 3] ??
            "results";
          updateFocus();
        } else if (
          keys.matches(data, "tui.select.confirm") ||
          (focus !== "search" && matchesKey(data, Key.space))
        ) {
          const target = focus === "actions" ? actions : list;
          const item = target.getSelectedItem();
          if (item) target.onSelect?.(item);
        } else if (
          keys.matches(data, "tui.select.up") ||
          keys.matches(data, "tui.select.down") ||
          keys.matches(data, "tui.select.pageUp") ||
          keys.matches(data, "tui.select.pageDown")
        ) {
          if (focus === "search") focus = "results";
          else (focus === "actions" ? actions : list).handleInput(data);
          updateFocus();
        } else {
          const printable = isSearchText(data);
          if (
            focus === "search" ||
            printable ||
            keys.matches(data, "tui.editor.deleteCharBackward")
          ) {
            focus = "search";
            updateFocus();
            search.handleInput(data);
          }
        }
        if (!disposed) tui.requestRender();
      },
      handleMouse(event) {
        if (disposed || busy) return undefined;
        if (details) {
          if (event.type !== "wheel" || !event.wheelDelta) return undefined;
          details.scrollBy(event.wheelDelta);
          tui.requestRender();
          return { handled: true };
        }
        const target = zones.find(
          (entry) => event.y >= entry.top && event.y < entry.top + entry.height,
        );
        if (!target) return undefined;
        focus = target.focus;
        updateFocus();
        const result = target.component.handleMouse?.({
          ...event,
          y: event.y - target.top,
          height: target.height,
        });
        if (result) tui.requestRender();
        return result ? { ...result, focus: true } : undefined;
      },
    };
    return component;
  };
}

/** Waiting never allows a disposed menu to apply changes to a replacement session. */
export async function waitForSettingsIdle(
  wait: () => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(new Error("Settings update cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    void wait()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
  signal.throwIfAborted();
}
