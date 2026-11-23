import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  settingsMenu,
  waitForSettingsIdle,
  type SettingsField,
  type SettingsMenuFactory,
} from "../settings-menu.ts";
import { SettingsStore } from "../settings-store.ts";
import {
  readSessionSettings,
  sessionSettingsEntry,
  type SettingsSessionContext,
} from "../settings-session.ts";
import {
  CONFIG_ENVIRONMENT_VARIABLES,
  CODEX_TOOL_BACKGROUND_SCHEMA,
  CODEX_SHELL_TOOL_SCHEMA,
  IMAGE_DETAIL_SCHEMA,
  REASONING_SUMMARY_SCHEMA,
  SPEED_SCHEMA,
  TEXT_VERBOSITY_SCHEMA,
  WEB_SEARCH_MODE_SCHEMA,
  globalConfigPath,
  projectConfigPath,
  parseEnvironmentConfig,
  parseConfig,
  resolveConfig,
  loadConfig,
  configLayer,
  type CodexCompatConfig,
  type MenuConfig,
} from "./config.ts";
import type { ConfigContext } from "./config-context.ts";
import { selectedRegistryModel } from "./model-context.ts";
import { isCodexModel } from "./request-options.ts";
import { usesResponsesLite } from "./responses-lite.ts";
import type { ServiceTierLookup } from "./footer.ts";
import { configServiceTier, serviceTierAvailable } from "./service-tier.ts";

export const settingFields: SettingsField[] = [
  {
    id: "speed",
    label: "Default speed",
    description:
      "Fast uses the priority tier. A speed applies to a model only if your plan includes it for that model; other requests run at Standard. speedByModel in the JSON file overrides it per model.",
    choices: [...SPEED_SCHEMA.enum],
  },
  {
    id: "responsesLite",
    label: "Responses Lite",
    description: "Use Responses Lite on supported models.",
    choices: [false, true],
  },
  {
    id: "textVerbosity",
    label: "Text verbosity",
    description: "Set Responses API text.verbosity.",
    choices: [...TEXT_VERBOSITY_SCHEMA.enum],
  },
  {
    id: "reasoningSummary",
    label: "Reasoning summary",
    description: "Choose reasoning summary detail, or omit summaries.",
    choices: [...REASONING_SUMMARY_SCHEMA.enum],
  },
  {
    id: "toolBackground",
    label: "Codex tool background",
    description: "Choose a subtle surface, Pi status colors, or no background.",
    choices: [...CODEX_TOOL_BACKGROUND_SCHEMA.enum],
  },
  {
    id: "shellTool",
    label: "Command tool",
    description:
      "Unified exec or shell_command. Collect pending output or stop sessions with /ps before switching.",
    choices: [...CODEX_SHELL_TOOL_SCHEMA.enum],
  },
  {
    id: "applyPatch",
    label: "apply_patch tool",
    description: "Replace Pi edit and write tools with Codex apply_patch.",
    choices: [false, true],
  },
  {
    id: "applyPatchDebug",
    label: "apply_patch debug output",
    description: "Show exact model feedback while patch output is collapsed.",
    choices: [false, true],
  },
  {
    id: "applyPatchDiagnostics",
    label: "apply_patch diagnostics capture",
    description:
      "Retain potentially sensitive file snapshots and failed patches in Pi's agent directory.",
    choices: [false, true],
  },
  {
    id: "imageGeneration",
    label: "image_gen.imagegen tool",
    description: "Generate or edit images through Codex.",
    choices: [false, true],
  },
  {
    id: "imageDetail",
    label: "Image result detail",
    description: "Set input_image.detail for returned images.",
    choices: [...IMAGE_DETAIL_SCHEMA.enum],
  },
  {
    id: "webRun",
    label: "web.run tool",
    description: "Use standalone search and browsing instead of hosted web search.",
    choices: [false, true],
  },
  {
    id: "webSearch",
    label: "Web search mode",
    description: "Disabled removes hosted search but leaves enabled web.run cached-only.",
    choices: [...WEB_SEARCH_MODE_SCHEMA.enum],
  },
  {
    id: "autoCompactAtPercent",
    label: "Auto-compact threshold",
    description:
      "An additional percentage trigger. Pi default disables the percentage override, not Pi auto-compaction.",
    choices: [null, 75, 80, 85, 90, 95],
    number: { min: 0, max: 100, exclusiveMin: true, unit: "%" },
    format: (value) => (value === null ? "Pi default" : `${value}%`),
  },
];

/** The values `/codex-settings` shows and edits. `speedByModel` is set only in JSON files. */
function menuValues(
  config: CodexCompatConfig,
): Omit<MenuConfig, "autoCompactAtPercent"> & { autoCompactAtPercent: number | null } {
  const { speedByModel: _speedByModel, ...values } = config;
  return { ...values, autoCompactAtPercent: config.autoCompactAtPercent ?? null };
}

/** What the Default speed row says about the selected model's speed, before its description. */
export function speedNote(
  config: CodexCompatConfig,
  modelId: string,
  catalogTiers: ReadonlySet<string> | undefined,
): string {
  const notes: string[] = [];
  if (Object.hasOwn(config.speedByModel, modelId)) {
    notes.push(`${modelId} uses its speedByModel value, ${config.speedByModel[modelId]}.`);
  }
  const tier = configServiceTier(config, modelId);
  if (tier !== undefined && !serviceTierAvailable(tier, catalogTiers)) {
    const speed = tier === "ultrafast" ? "Ultrafast" : "Fast";
    notes.push(
      catalogTiers === undefined
        ? `${modelId} runs at Standard until the Codex model catalog shows ${speed} for it.`
        : `Your plan does not include ${speed} for ${modelId}, so it runs at Standard.`,
    );
  }
  return notes.map((note) => `${note} `).join("");
}

export type SettingsChangeContext = { model: Model<Api> | undefined; sessionId: string };
export type SettingsCallbacks = {
  getConfig: (ctx: ConfigContext) => CodexCompatConfig;
  /** The tiers the account's model catalog lists for a model, or `undefined` if unknown. */
  serviceTiers: ServiceTierLookup;
  onChange: (config: CodexCompatConfig, ctx: SettingsChangeContext) => void;
  hasPersistentSessions?: () => boolean;
};
export type CodexSettingsContext = ConfigContext &
  SettingsSessionContext &
  Pick<ExtensionCommandContext, "mode" | "model" | "isIdle" | "waitForIdle"> & {
    modelRegistry: Pick<ExtensionCommandContext["modelRegistry"], "find">;
    ui: {
      custom: <T>(factory: SettingsMenuFactory<T>) => Promise<T>;
      notify: ExtensionCommandContext["ui"]["notify"];
    };
  };
export type CodexSettingsHandler = (args: string, ctx: CodexSettingsContext) => Promise<void>;
export type CodexSettingsApi = {
  appendEntry: (customType: string, data: unknown) => void;
  registerCommand: (
    name: string,
    options: { description: string; handler: CodexSettingsHandler },
  ) => void;
};
export const SESSION_SETTINGS_TYPE = "pi-openai-codex-compat:settings";

export function loadSessionConfig(ctx: ConfigContext & SettingsSessionContext): CodexCompatConfig {
  const saved = readSessionSettings(ctx, SESSION_SETTINGS_TYPE, settingFields);
  return resolveConfig(
    configLayer(loadConfig(ctx.cwd, ctx.isProjectTrusted())),
    parseConfig(saved.values),
    parseEnvironmentConfig(),
  );
}

export default function registerCodexSettings(
  pi: CodexSettingsApi,
  callbacks: SettingsCallbacks,
): void {
  pi.registerCommand("codex-settings", {
    description: "Configure OpenAI Codex compatibility",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/codex-settings requires TUI mode.", "error");
        return;
      }
      try {
        const environment = parseEnvironmentConfig();
        const locked = Object.fromEntries(
          Object.entries(CONFIG_ENVIRONMENT_VARIABLES).filter(([id]) =>
            Object.hasOwn(environment, id),
          ),
        );
        const sessionId = ctx.sessionManager.getSessionId();
        const trusted = ctx.isProjectTrusted();
        const store = new SettingsStore(
          globalConfigPath(),
          trusted ? projectConfigPath(ctx.cwd) : undefined,
          (global, project) =>
            menuValues(resolveConfig(parseConfig(global), parseConfig(project), environment)),
          locked,
          (data) => ({ ...parseConfig(data) }),
        );
        const snapshot = await store.load();
        const selection = ctx.model;
        const current = callbacks.getConfig(ctx);
        const sessionState = readSessionSettings(ctx, SESSION_SETTINGS_TYPE, settingFields).session;
        for (const id of Object.keys(locked)) delete sessionState.changes[id];
        let appliedShell = current.shellTool;
        const model = selectedRegistryModel(ctx);
        const fields = settingFields.map((field) => {
          const inactive =
            !isCodexModel(model) || (field.id === "responsesLite" && !usesResponsesLite(model.id));
          const note =
            field.id === "speed" && isCodexModel(model)
              ? speedNote(current, model.id, callbacks.serviceTiers(model.id))
              : "";
          return {
            ...field,
            description: `${inactive ? "Inactive on this model. " : ""}${note}${field.description}`,
          };
        });
        await ctx.ui.custom(
          settingsMenu({
            title: "Codex Settings",
            store,
            snapshot,
            current: menuValues(current),
            session: sessionState,
            fields,
            status: () =>
              isCodexModel(model)
                ? "Codex settings apply when applied to session or saved."
                : "Configured preferences are inactive on this provider.",
            prepare: (signal) => waitForSettingsIdle(() => ctx.waitForIdle(), signal),
            guard: (values) => {
              if (ctx.model?.id !== selection?.id || ctx.model?.provider !== selection?.provider) {
                throw new Error("The selected model changed. Reopen settings.");
              }
              if (
                sessionId !== ctx.sessionManager.getSessionId() ||
                trusted !== ctx.isProjectTrusted()
              ) {
                throw new Error("The session or project trust changed. Reopen settings.");
              }
              if (!ctx.isIdle()) throw new Error("Pi is busy. Retry when idle.");
              if (values["shellTool"] !== appliedShell && callbacks.hasPersistentSessions?.()) {
                throw new Error(
                  "Collect pending output with write_stdin or stop running sessions with /ps before changing Command tool.",
                );
              }
            },
            apply: (values, nextSession) => {
              const config = {
                ...resolveConfig(parseConfig(values), {}, environment),
                speedByModel: current.speedByModel,
              };
              pi.appendEntry(
                SESSION_SETTINGS_TYPE,
                sessionSettingsEntry(sessionId, values, nextSession, locked),
              );
              callbacks.onChange(config, { model: selectedRegistryModel(ctx), sessionId });
              appliedShell = config.shellTool;
            },
          }),
        );
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : "Could not open Codex settings.",
          "error",
        );
      }
    },
  });
}
