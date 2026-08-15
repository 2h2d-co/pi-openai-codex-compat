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
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  CONFIG_ENVIRONMENT_VARIABLES,
  configLayer,
  loadConfig,
  parseEnvironmentConfig,
  saveConfig,
  withoutEnvironmentOverrides,
  writableConfigPath,
  type CodexCompatConfig,
  type ConfigLayer,
} from "./config.ts";

const COMMAND_NAME = "codex-settings";

type SettingId =
  | "fastMode"
  | "responsesLite"
  | "textVerbosity"
  | "reasoningSummary"
  | "reasoningMode"
  | "toolBackground"
  | "applyPatch"
  | "applyPatchDebug"
  | "imageGeneration"
  | "imageDetail"
  | "webRun"
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

export function settingItems(
  config: CodexCompatConfig,
  environmentConfig: ConfigLayer = {},
): SettingItem[] {
  const items: SettingItem[] = [
    {
      id: "fastMode",
      label: "Fast mode",
      description: "Send requests through OpenAI's priority service tier.",
      currentValue: toggleValue(config.fastMode),
      values: ["off", "on"],
    },
    {
      id: "responsesLite",
      label: "Responses Lite",
      description: "Use Codex's Responses Lite envelope on supported GPT-5.6 models.",
      currentValue: toggleValue(config.responsesLite),
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
      id: "toolBackground",
      label: "Codex tool background",
      description: "Choose a distinct subtle surface, Pi's normal status colors, or no background.",
      currentValue: config.toolBackground,
      values: ["subtle", "status", "none"],
    },
    {
      id: "applyPatch",
      label: "apply_patch tool",
      description: "Use Codex apply_patch instead of Pi's edit and write tools.",
      currentValue: toggleValue(config.applyPatch),
      values: ["off", "on"],
    },
    {
      id: "applyPatchDebug",
      label: "apply_patch debug output",
      description: "Show exact model feedback while apply_patch output is collapsed.",
      currentValue: toggleValue(config.applyPatchDebug),
      values: ["off", "on"],
    },
    {
      id: "imageGeneration",
      label: "image_gen.imagegen tool",
      description: "Generate or edit images through the standalone Codex image endpoint.",
      currentValue: toggleValue(config.imageGeneration),
      values: ["off", "on"],
    },
    {
      id: "imageDetail",
      label: "Image result detail",
      description: "Set input_image.detail when image tool results are returned to the model.",
      currentValue: config.imageDetail,
      values: ["auto", "low", "high", "original"],
    },
    {
      id: "webRun",
      label: "web.run tool",
      description: "Search and browse through the standalone Codex search endpoint.",
      currentValue: toggleValue(config.webRun),
      values: ["off", "on"],
    },
    {
      id: "webSearch",
      label: "Web search mode",
      description:
        "Control hosted search and web.run access: disabled removes hosted search but keeps web.run cached-only.",
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

  return items.map((item) => {
    const id = item.id as SettingId;
    if (!Object.hasOwn(environmentConfig, id)) return item;

    const variable = CONFIG_ENVIRONMENT_VARIABLES[id];
    const lockedItem = { ...item };
    lockedItem.currentValue = `${item.currentValue} (env)`;
    lockedItem.description = `${item.description} Locked by ${variable}.`;
    delete lockedItem.values;
    return lockedItem;
  });
}

export function settingPatch(id: string, value: string): ConfigLayer | undefined {
  switch (id as SettingId) {
    case "fastMode":
      return value === "on" || value === "off" ? { fastMode: value === "on" } : undefined;
    case "responsesLite":
      return value === "on" || value === "off" ? { responsesLite: value === "on" } : undefined;
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
    case "toolBackground":
      if (value === "subtle" || value === "status" || value === "none") {
        return { toolBackground: value };
      }
      return undefined;
    case "applyPatch":
      return value === "on" || value === "off" ? { applyPatch: value === "on" } : undefined;
    case "applyPatchDebug":
      return value === "on" || value === "off" ? { applyPatchDebug: value === "on" } : undefined;
    case "imageGeneration":
      return value === "on" || value === "off" ? { imageGeneration: value === "on" } : undefined;
    case "imageDetail":
      if (value === "auto" || value === "low" || value === "high" || value === "original") {
        return { imageDetail: value };
      }
      return undefined;
    case "webRun":
      return value === "on" || value === "off" ? { webRun: value === "on" } : undefined;
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
  if (typeof patch.responsesLite === "boolean") next.responsesLite = patch.responsesLite;
  if (typeof patch.applyPatch === "boolean") next.applyPatch = patch.applyPatch;
  if (typeof patch.applyPatchDebug === "boolean") next.applyPatchDebug = patch.applyPatchDebug;
  if (patch.toolBackground) next.toolBackground = patch.toolBackground;
  if (typeof patch.imageGeneration === "boolean") {
    next.imageGeneration = patch.imageGeneration;
  }
  if (patch.imageDetail) next.imageDetail = patch.imageDetail;
  if (typeof patch.webRun === "boolean") next.webRun = patch.webRun;
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
  let persistedConfig = { ...config };
  let revision = 0;
  let savedRevision = 0;
  let saveQueue = Promise.resolve();
  const filePath = writableConfigPath(ctx.cwd, ctx.isProjectTrusted());
  const environmentConfig = parseEnvironmentConfig();

  await ctx.ui.custom((tui, theme, keybindings, done) => {
    let closing = false;
    const container = new Container();
    container.addChild(
      new Text(theme.fg("accent", theme.bold("OpenAI Codex Compatibility Settings")), 1, 1),
    );
    container.addChild(
      new Text(theme.fg("dim", `Ctrl+S saves without closing to ${filePath}`), 1, 0),
    );
    const saveStatus = new Text(
      theme.fg("dim", "Changes apply to this session immediately."),
      1,
      0,
    );
    container.addChild(saveStatus);

    const queueSave = (closeAfterSave: boolean): void => {
      if (closing) return;
      if (closeAfterSave) closing = true;

      const snapshotConfig = { ...config };
      const snapshot = withoutEnvironmentOverrides(configLayer(snapshotConfig), environmentConfig);
      const snapshotRevision = revision;
      saveStatus.setText(theme.fg("dim", closeAfterSave ? "Saving and closing…" : "Saving…"));
      saveQueue = saveQueue.then(async () => {
        try {
          const savedPath = await saveConfig(ctx.cwd, ctx.isProjectTrusted(), snapshot);
          if (snapshotRevision >= savedRevision) {
            persistedConfig = snapshotConfig;
            savedRevision = snapshotRevision;
          }
          if (closeAfterSave) {
            done(undefined);
            return;
          }
          saveStatus.setText(
            savedRevision === revision
              ? theme.fg("success", `Saved to ${savedPath}`)
              : theme.fg("warning", "Unsaved session changes."),
          );
        } catch (error) {
          if (closeAfterSave) closing = false;
          const message = error instanceof Error ? error.message : String(error);
          saveStatus.setText(theme.fg("error", message));
          ctx.ui.notify(message, "error");
        }
        tui.requestRender();
      });
      tui.requestRender();
    };

    const discardAndClose = (): void => {
      if (closing) return;
      closing = true;
      saveStatus.setText(theme.fg("dim", "Discarding unsaved changes…"));
      saveQueue = saveQueue.then(() => {
        if (revision !== savedRevision) {
          config = { ...persistedConfig };
          revision = savedRevision;
          callbacks.onChange?.(config, ctx);
        }
        done(undefined);
      });
      tui.requestRender();
    };

    const listTheme = getSettingsListTheme();
    const list = new SettingsList(
      settingItems(config, environmentConfig),
      12,
      listTheme,
      (id, value) => {
        const patch = settingPatch(id, value);
        if (!patch) return;

        config = applySettingPatch(config, patch);
        revision++;
        callbacks.onChange?.(config, ctx);
        saveStatus.setText(theme.fg("warning", "Unsaved session changes."));
        tui.requestRender();
      },
      discardAndClose,
      { enableSearch: true },
    );
    container.addChild({
      render: (width: number) => {
        const lines = list.render(width);
        if (lines.length > 0) {
          lines[lines.length - 1] = truncateToWidth(
            listTheme.hint(
              "  Type to search · Space changes · Enter save & close · Esc discard & close",
            ),
            width,
            "",
          );
        }
        return lines;
      },
      invalidate: () => list.invalidate(),
      handleInput: (data: string) => list.handleInput(data),
    });

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (closing) return;
        if (matchesKey(data, Key.ctrl("s"))) {
          queueSave(false);
          return;
        }
        if (matchesKey(data, Key.enter)) {
          queueSave(true);
          return;
        }
        if (matchesKey(data, Key.escape) || keybindings.matches(data, "tui.select.cancel")) {
          discardAndClose();
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
