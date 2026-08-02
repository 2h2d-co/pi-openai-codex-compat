import {
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  type SettingItem,
  SettingsList,
  Text,
} from "@earendil-works/pi-tui";
import {
  configLayer,
  loadConfig,
  saveConfig,
  writableConfigPath,
  type CodexCompatConfig,
  type ConfigLayer,
} from "./config.ts";

const COMMAND_NAME = "codex-settings";

type SettingId =
  | "fastMode"
  | "textVerbosity"
  | "reasoningSummary"
  | "reasoningMode"
  | "applyPatch"
  | "webSearch"
  | "autoCompactAtPercent";

export type SettingsCallbacks = {
  getConfig?: (ctx: ExtensionCommandContext) => CodexCompatConfig;
  onChange?: (config: CodexCompatConfig, ctx: ExtensionCommandContext) => void;
};

function toggleValue(value: boolean): string {
  return value ? "on" : "off";
}

function thresholdValue(value: number | undefined): string {
  return value === undefined ? "Pi default" : `${value}%`;
}

export function settingItems(config: CodexCompatConfig): SettingItem[] {
  return [
    {
      id: "fastMode",
      label: "Fast mode",
      description: "Send requests through OpenAI's priority service tier.",
      currentValue: toggleValue(config.fastMode),
      values: ["off", "on"],
    },
    {
      id: "textVerbosity",
      label: "Text verbosity",
      description: "Set Responses API text.verbosity.",
      currentValue: config.textVerbosity,
      values: ["low", "medium", "high"],
    },
    {
      id: "reasoningSummary",
      label: "Reasoning summary",
      description: "Choose the reasoning summary detail, or omit summaries.",
      currentValue: config.reasoningSummary,
      values: ["auto", "concise", "detailed", "off"],
    },
    {
      id: "reasoningMode",
      label: "Reasoning mode",
      description:
        "Choose standard or pro execution independently of reasoning effort. Applied only to GPT-5.6 models.",
      currentValue: config.reasoningMode,
      values: ["standard", "pro"],
    },
    {
      id: "applyPatch",
      label: "apply_patch tool",
      description: "Enable the workspace-scoped Codex apply_patch tool in Pi.",
      currentValue: toggleValue(config.applyPatch),
      values: ["off", "on"],
    },
    {
      id: "webSearch",
      label: "Web search tool",
      description:
        "Disable hosted search, use cached results only, prefer indexed results, or permit live access.",
      currentValue: config.webSearch,
      values: ["disabled", "cached", "indexed", "live"],
    },
    {
      id: "autoCompactAtPercent",
      label: "Auto-compact threshold",
      description: "Add provider-boundary compaction or rely on Pi's normal compaction threshold.",
      currentValue: thresholdValue(config.autoCompactAtPercent),
      values: ["Pi default", "75%", "80%", "85%", "90%", "95%"],
    },
  ];
}

export function settingPatch(id: string, value: string): ConfigLayer | undefined {
  switch (id as SettingId) {
    case "fastMode":
      return value === "on" || value === "off" ? { fastMode: value === "on" } : undefined;
    case "textVerbosity":
      if (value === "low" || value === "medium" || value === "high") {
        return { textVerbosity: value };
      }
      return undefined;
    case "reasoningSummary":
      if (value === "auto" || value === "concise" || value === "detailed" || value === "off") {
        return { reasoningSummary: value };
      }
      return undefined;
    case "reasoningMode":
      if (value === "standard" || value === "pro") return { reasoningMode: value };
      return undefined;
    case "applyPatch":
      return value === "on" || value === "off" ? { applyPatch: value === "on" } : undefined;
    case "webSearch":
      if (value === "disabled" || value === "cached" || value === "indexed" || value === "live") {
        return { webSearch: value };
      }
      return undefined;
    case "autoCompactAtPercent": {
      if (value === "Pi default") return { autoCompactAtPercent: null };
      const percent = Number(value.replace(/%$/, ""));
      return Number.isFinite(percent) && percent > 0 && percent <= 100
        ? { autoCompactAtPercent: percent }
        : undefined;
    }
  }
}

function applySettingPatch(config: CodexCompatConfig, patch: ConfigLayer): CodexCompatConfig {
  const next: CodexCompatConfig = { ...config };
  if (typeof patch.fastMode === "boolean") next.fastMode = patch.fastMode;
  if (typeof patch.applyPatch === "boolean") next.applyPatch = patch.applyPatch;
  if (patch.webSearch) next.webSearch = patch.webSearch;
  if (patch.textVerbosity) next.textVerbosity = patch.textVerbosity;
  if (patch.reasoningSummary) next.reasoningSummary = patch.reasoningSummary;
  if (patch.reasoningMode) next.reasoningMode = patch.reasoningMode;
  if (typeof patch.autoCompactAtPercent === "number") {
    next.autoCompactAtPercent = patch.autoCompactAtPercent;
  } else if (patch.autoCompactAtPercent === null) {
    delete next.autoCompactAtPercent;
  }
  return next;
}

async function showSettings(
  ctx: ExtensionCommandContext,
  callbacks: SettingsCallbacks,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(`/${COMMAND_NAME} requires TUI mode`, "error");
    return;
  }

  let config = callbacks.getConfig?.(ctx) ?? loadConfig(ctx.cwd, ctx.isProjectTrusted());
  let revision = 0;
  let savedRevision = 0;
  let saveQueue = Promise.resolve();
  const filePath = writableConfigPath(ctx.cwd, ctx.isProjectTrusted());

  await ctx.ui.custom((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(
      new Text(theme.fg("accent", theme.bold("OpenAI Codex Compatibility Settings")), 1, 1),
    );
    container.addChild(
      new Text(theme.fg("dim", `Session-only. Ctrl+S saves to ${filePath}`), 1, 0),
    );
    const saveStatus = new Text(
      theme.fg("dim", "Changes apply to this session immediately."),
      1,
      0,
    );
    container.addChild(saveStatus);

    const list = new SettingsList(
      settingItems(config),
      12,
      getSettingsListTheme(),
      (id, value) => {
        const patch = settingPatch(id, value);
        if (!patch) return;

        config = applySettingPatch(config, patch);
        revision++;
        callbacks.onChange?.(config, ctx);
        saveStatus.setText(theme.fg("warning", "Unsaved session changes."));
        tui.requestRender();
      },
      () => done(undefined),
      { enableSearch: true },
    );
    container.addChild(list);

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, Key.ctrl("s"))) {
          const snapshot = configLayer(config);
          const snapshotRevision = revision;
          saveStatus.setText(theme.fg("dim", "Saving…"));
          saveQueue = saveQueue.then(async () => {
            try {
              const savedPath = await saveConfig(ctx.cwd, ctx.isProjectTrusted(), snapshot);
              savedRevision = Math.max(savedRevision, snapshotRevision);
              saveStatus.setText(
                savedRevision === revision
                  ? theme.fg("success", `Saved to ${savedPath}`)
                  : theme.fg("warning", "Unsaved session changes."),
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              saveStatus.setText(theme.fg("error", message));
              ctx.ui.notify(message, "error");
            }
            tui.requestRender();
          });
          tui.requestRender();
          return;
        }
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });

  await saveQueue;
}

export default function registerCodexSettings(
  pi: ExtensionAPI,
  callbacks: SettingsCallbacks = {},
): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Configure OpenAI Codex compatibility",
    handler: async (_args, ctx) => showSettings(ctx, callbacks),
  });
}
