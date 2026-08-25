import { isBoolean, isNumber, nodeErrorCode } from "./value-contracts.ts";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { isObject, type JsonRecord } from "./codex-protocol.ts";

export const WEB_SEARCH_MODE_SCHEMA = {
  enum: ["disabled", "cached", "indexed", "live"],
} as const;

export type WebSearchMode = Static<typeof WEB_SEARCH_MODE_SCHEMA>;

export const TEXT_VERBOSITY_SCHEMA = {
  enum: ["low", "medium", "high"],
} as const;

export type TextVerbosity = Static<typeof TEXT_VERBOSITY_SCHEMA>;

export const REASONING_SUMMARY_SCHEMA = {
  enum: ["auto", "concise", "detailed", "off"],
} as const;

export type ReasoningSummary = Static<typeof REASONING_SUMMARY_SCHEMA>;

export const REASONING_MODE_SCHEMA = {
  enum: ["standard", "pro"],
} as const;

export type ReasoningMode = Static<typeof REASONING_MODE_SCHEMA>;

export const IMAGE_DETAIL_SCHEMA = {
  enum: ["auto", "low", "high", "original"],
} as const;

export type ImageDetail = Static<typeof IMAGE_DETAIL_SCHEMA>;

export const CODEX_TOOL_BACKGROUND_SCHEMA = {
  enum: ["subtle", "status", "none"],
} as const;

export type CodexToolBackground = Static<typeof CODEX_TOOL_BACKGROUND_SCHEMA>;

export const CODEX_SHELL_TOOL_SCHEMA = {
  enum: ["unified_exec", "shell_command"],
} as const;

export type CodexShellTool = Static<typeof CODEX_SHELL_TOOL_SCHEMA>;

export const ENV_PREFIX = "PI_OPENAI_CODEX_COMPAT_";

export interface CodexCompatConfig {
  /** Send OpenAI Codex requests through the priority service tier. */
  fastMode: boolean;
  /** Use Codex's Responses Lite envelope on supported GPT-5.6 models. */
  responsesLite: boolean;
  /** Replace Pi's active edit and write tools with the extension's apply_patch tool. */
  applyPatch: boolean;
  /** Show exact model-facing apply_patch feedback while its TUI result is collapsed. */
  applyPatchDebug: boolean;
  /** Persist failed apply_patch requests and their complete pre-execution snapshots for review. */
  applyPatchDiagnostics: boolean;
  /** Select the shared background surface for extension-owned Codex tools. */
  toolBackground: CodexToolBackground;
  /** Select the model-visible command tool family for OpenAI Codex models. */
  shellTool: CodexShellTool;
  /** Expose the standalone Codex image-generation namespace tool. */
  imageGeneration: boolean;
  /** Set input_image.detail when image tool results are returned to the model. */
  imageDetail: ImageDetail;
  /** Expose the standalone Codex web-search namespace tool. */
  webRun: boolean;
  /**
   * Compact at provider request boundaries when context usage reaches this
   * percentage. Mid-response boundaries use Pi's bounded compact-and-continue
   * lifecycle, so Pi auto-compaction must remain enabled.
   */
  autoCompactAtPercent?: number;
  webSearch: WebSearchMode;
  textVerbosity: TextVerbosity;
  reasoningSummary: ReasoningSummary;
  reasoningMode: ReasoningMode;
}

export const CONFIG_ENVIRONMENT_VARIABLES = {
  fastMode: `${ENV_PREFIX}FAST_MODE`,
  responsesLite: `${ENV_PREFIX}RESPONSES_LITE`,
  applyPatch: `${ENV_PREFIX}APPLY_PATCH`,
  applyPatchDebug: `${ENV_PREFIX}APPLY_PATCH_DEBUG`,
  applyPatchDiagnostics: `${ENV_PREFIX}APPLY_PATCH_DIAGNOSTICS`,
  toolBackground: `${ENV_PREFIX}TOOL_BACKGROUND`,
  shellTool: `${ENV_PREFIX}SHELL_TOOL`,
  imageGeneration: `${ENV_PREFIX}IMAGE_GENERATION`,
  imageDetail: `${ENV_PREFIX}IMAGE_DETAIL`,
  webRun: `${ENV_PREFIX}WEB_RUN`,
  autoCompactAtPercent: `${ENV_PREFIX}AUTO_COMPACT_AT_PERCENT`,
  webSearch: `${ENV_PREFIX}WEB_SEARCH_MODE`,
  textVerbosity: `${ENV_PREFIX}TEXT_VERBOSITY`,
  reasoningSummary: `${ENV_PREFIX}REASONING_SUMMARY`,
  reasoningMode: `${ENV_PREFIX}REASONING_MODE`,
} as const satisfies Record<keyof CodexCompatConfig, string>;

export type ConfigLayer = {
  fastMode?: boolean;
  responsesLite?: boolean;
  applyPatch?: boolean;
  applyPatchDebug?: boolean;
  applyPatchDiagnostics?: boolean;
  toolBackground?: CodexToolBackground;
  shellTool?: CodexShellTool;
  imageGeneration?: boolean;
  imageDetail?: ImageDetail;
  webRun?: boolean;
  autoCompactAtPercent?: number | null;
  webSearch?: WebSearchMode;
  textVerbosity?: TextVerbosity;
  reasoningSummary?: ReasoningSummary;
  reasoningMode?: ReasoningMode;
};

export const CONFIG_FILE = "openai-codex-compat.json";
export const DEFAULT_CONFIG: CodexCompatConfig = {
  fastMode: false,
  responsesLite: false,
  applyPatch: true,
  applyPatchDebug: false,
  applyPatchDiagnostics: false,
  toolBackground: "subtle",
  shellTool: "unified_exec",
  imageGeneration: true,
  imageDetail: "auto",
  webRun: false,
  webSearch: "disabled",
  textVerbosity: "low",
  reasoningSummary: "auto",
  reasoningMode: "standard",
};

type Environment = Readonly<Record<string, string | undefined>>;

function invalidEnvironmentValue(name: string, value: string, expected: string): never {
  throw new Error(`Invalid ${name}=${JSON.stringify(value)}; expected ${expected}`);
}

function environmentBoolean(environment: Environment, name: string): boolean | undefined {
  const raw = environment[name];
  if (raw === undefined) return undefined;

  switch (raw.trim().toLowerCase()) {
    case "1":
    case "enabled":
    case "on":
    case "true":
      return true;
    case "0":
    case "disabled":
    case "off":
    case "false":
      return false;
    default:
      return invalidEnvironmentValue(name, raw, "true, false, 1, 0, on, off, enabled, or disabled");
  }
}

function environmentEnum<const Schema extends { readonly enum: readonly string[] }>(
  environment: Environment,
  name: string,
  schema: Schema,
): Static<Schema> | undefined {
  const raw = environment[name];
  if (raw === undefined) return undefined;

  const value = raw.trim();
  if (Value.Check(schema, value)) return value;
  return invalidEnvironmentValue(name, raw, schema.enum.join(", "));
}

/**
 * Parse explicit process-level overrides. Unlike invalid JSON settings, invalid
 * environment values fail fast so a CLI test cannot silently exercise a
 * different configuration than requested.
 */
export function parseEnvironmentConfig(environment: Environment = process.env): ConfigLayer {
  const layer: ConfigLayer = {};

  const fastMode = environmentBoolean(environment, CONFIG_ENVIRONMENT_VARIABLES.fastMode);
  if (fastMode !== undefined) layer.fastMode = fastMode;

  const responsesLite = environmentBoolean(environment, CONFIG_ENVIRONMENT_VARIABLES.responsesLite);
  if (responsesLite !== undefined) layer.responsesLite = responsesLite;

  const applyPatch = environmentBoolean(environment, CONFIG_ENVIRONMENT_VARIABLES.applyPatch);
  if (applyPatch !== undefined) layer.applyPatch = applyPatch;

  const applyPatchDebug = environmentBoolean(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.applyPatchDebug,
  );
  if (applyPatchDebug !== undefined) layer.applyPatchDebug = applyPatchDebug;

  const applyPatchDiagnostics = environmentBoolean(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.applyPatchDiagnostics,
  );
  if (applyPatchDiagnostics !== undefined) {
    layer.applyPatchDiagnostics = applyPatchDiagnostics;
  }

  const toolBackground = environmentEnum(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.toolBackground,
    CODEX_TOOL_BACKGROUND_SCHEMA,
  );
  if (toolBackground !== undefined) layer.toolBackground = toolBackground;

  const shellTool = environmentEnum(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.shellTool,
    CODEX_SHELL_TOOL_SCHEMA,
  );
  if (shellTool !== undefined) layer.shellTool = shellTool;

  const imageGeneration = environmentBoolean(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.imageGeneration,
  );
  if (imageGeneration !== undefined) layer.imageGeneration = imageGeneration;

  const imageDetail = environmentEnum(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.imageDetail,
    IMAGE_DETAIL_SCHEMA,
  );
  if (imageDetail !== undefined) layer.imageDetail = imageDetail;

  const webRun = environmentBoolean(environment, CONFIG_ENVIRONMENT_VARIABLES.webRun);
  if (webRun !== undefined) layer.webRun = webRun;

  const thresholdName = CONFIG_ENVIRONMENT_VARIABLES.autoCompactAtPercent;
  const rawThreshold = environment[thresholdName];
  if (rawThreshold !== undefined) {
    const value = rawThreshold.trim();
    if (value.toLowerCase() === "off" || value.toLowerCase() === "default") {
      layer.autoCompactAtPercent = null;
    } else {
      const threshold = Number(value);
      if (value.length === 0 || !Number.isFinite(threshold) || threshold <= 0 || threshold > 100) {
        invalidEnvironmentValue(
          thresholdName,
          rawThreshold,
          "a number greater than 0 and at most 100, off, or default",
        );
      }
      layer.autoCompactAtPercent = threshold;
    }
  }

  const webSearch = environmentEnum(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.webSearch,
    WEB_SEARCH_MODE_SCHEMA,
  );
  if (webSearch !== undefined) layer.webSearch = webSearch;

  const textVerbosity = environmentEnum(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.textVerbosity,
    TEXT_VERBOSITY_SCHEMA,
  );
  if (textVerbosity !== undefined) layer.textVerbosity = textVerbosity;

  const reasoningSummary = environmentEnum(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.reasoningSummary,
    REASONING_SUMMARY_SCHEMA,
  );
  if (reasoningSummary !== undefined) layer.reasoningSummary = reasoningSummary;

  const reasoningMode = environmentEnum(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.reasoningMode,
    REASONING_MODE_SCHEMA,
  );
  if (reasoningMode !== undefined) layer.reasoningMode = reasoningMode;

  return layer;
}

export function parseConfig(value: unknown): ConfigLayer {
  if (!isObject(value)) return {};

  const layer: ConfigLayer = {};

  const fastMode = value["fastMode"];
  if (isBoolean(fastMode)) layer.fastMode = fastMode;

  const responsesLite = value["responsesLite"];
  if (isBoolean(responsesLite)) layer.responsesLite = responsesLite;

  const applyPatch = value["applyPatch"];
  if (isBoolean(applyPatch)) layer.applyPatch = applyPatch;

  const applyPatchDebug = value["applyPatchDebug"];
  if (isBoolean(applyPatchDebug)) layer.applyPatchDebug = applyPatchDebug;

  const applyPatchDiagnostics = value["applyPatchDiagnostics"];
  if (isBoolean(applyPatchDiagnostics)) {
    layer.applyPatchDiagnostics = applyPatchDiagnostics;
  }

  const toolBackground = value["toolBackground"];
  if (Value.Check(CODEX_TOOL_BACKGROUND_SCHEMA, toolBackground)) {
    layer.toolBackground = toolBackground;
  }

  const shellTool = value["shellTool"];
  if (Value.Check(CODEX_SHELL_TOOL_SCHEMA, shellTool)) {
    layer.shellTool = shellTool;
  }

  const imageGeneration = value["imageGeneration"];
  if (isBoolean(imageGeneration)) layer.imageGeneration = imageGeneration;

  const imageDetail = value["imageDetail"];
  if (Value.Check(IMAGE_DETAIL_SCHEMA, imageDetail)) {
    layer.imageDetail = imageDetail;
  }

  const webRun = value["webRun"];
  if (isBoolean(webRun)) layer.webRun = webRun;

  const threshold = value["autoCompactAtPercent"];
  if (threshold === null) {
    layer.autoCompactAtPercent = null;
  } else if (
    isNumber(threshold) &&
    Number.isFinite(threshold) &&
    threshold > 0 &&
    threshold <= 100
  ) {
    layer.autoCompactAtPercent = threshold;
  }

  const webSearch = value["webSearch"];
  if (Value.Check(WEB_SEARCH_MODE_SCHEMA, webSearch)) {
    layer.webSearch = webSearch;
  }

  const textVerbosity = value["textVerbosity"];
  if (Value.Check(TEXT_VERBOSITY_SCHEMA, textVerbosity)) {
    layer.textVerbosity = textVerbosity;
  }

  const reasoningSummary = value["reasoningSummary"];
  if (Value.Check(REASONING_SUMMARY_SCHEMA, reasoningSummary)) {
    layer.reasoningSummary = reasoningSummary;
  }

  const reasoningMode = value["reasoningMode"];
  if (Value.Check(REASONING_MODE_SCHEMA, reasoningMode)) {
    layer.reasoningMode = reasoningMode;
  }

  return layer;
}

function readConfig(filePath: string): ConfigLayer {
  if (!existsSync(filePath)) return {};

  try {
    return parseConfig(JSON.parse(readFileSync(filePath, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError || nodeErrorCode(error) === "ENOENT") {
      // Invalid or concurrently removed configuration must not prevent Pi from starting.
      return {};
    }
    throw new Error(`Could not read configuration ${filePath}`, { cause: error });
  }
}

export function resolveConfig(
  globalConfig: ConfigLayer,
  projectConfig: ConfigLayer,
  environmentConfig: ConfigLayer = {},
): CodexCompatConfig {
  const merged = { ...globalConfig, ...projectConfig, ...environmentConfig };
  const config = { ...DEFAULT_CONFIG };
  if (isBoolean(merged.fastMode)) config.fastMode = merged.fastMode;
  if (isBoolean(merged.responsesLite)) config.responsesLite = merged.responsesLite;
  if (isBoolean(merged.applyPatch)) config.applyPatch = merged.applyPatch;
  if (isBoolean(merged.applyPatchDebug)) config.applyPatchDebug = merged.applyPatchDebug;
  if (isBoolean(merged.applyPatchDiagnostics)) {
    config.applyPatchDiagnostics = merged.applyPatchDiagnostics;
  }
  if (merged.toolBackground) config.toolBackground = merged.toolBackground;
  if (merged.shellTool) config.shellTool = merged.shellTool;
  if (isBoolean(merged.imageGeneration)) config.imageGeneration = merged.imageGeneration;
  if (merged.imageDetail) config.imageDetail = merged.imageDetail;
  if (isBoolean(merged.webRun)) config.webRun = merged.webRun;
  if (isNumber(merged.autoCompactAtPercent)) {
    config.autoCompactAtPercent = merged.autoCompactAtPercent;
  }
  if (merged.webSearch) config.webSearch = merged.webSearch;
  if (merged.textVerbosity) config.textVerbosity = merged.textVerbosity;
  if (merged.reasoningSummary) config.reasoningSummary = merged.reasoningSummary;
  if (merged.reasoningMode) config.reasoningMode = merged.reasoningMode;
  return config;
}

export function globalConfigPath(): string {
  return join(getAgentDir(), CONFIG_FILE);
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, CONFIG_FILE);
}

/** Use an existing trusted project override; otherwise persist global settings. */
export function writableConfigPath(cwd: string, projectTrusted: boolean): string {
  const projectPath = projectConfigPath(cwd);
  return projectTrusted && existsSync(projectPath) ? projectPath : globalConfigPath();
}

export function loadConfig(
  cwd: string,
  projectTrusted: boolean,
  environment: Environment = process.env,
): CodexCompatConfig {
  const globalConfig = readConfig(globalConfigPath());
  const projectConfig = projectTrusted ? readConfig(projectConfigPath(cwd)) : {};
  return resolveConfig(globalConfig, projectConfig, parseEnvironmentConfig(environment));
}

export function configLayer(config: CodexCompatConfig): ConfigLayer {
  return {
    fastMode: config.fastMode,
    responsesLite: config.responsesLite,
    applyPatch: config.applyPatch,
    applyPatchDebug: config.applyPatchDebug,
    applyPatchDiagnostics: config.applyPatchDiagnostics,
    toolBackground: config.toolBackground,
    shellTool: config.shellTool,
    imageGeneration: config.imageGeneration,
    imageDetail: config.imageDetail,
    webRun: config.webRun,
    autoCompactAtPercent: config.autoCompactAtPercent ?? null,
    webSearch: config.webSearch,
    textVerbosity: config.textVerbosity,
    reasoningSummary: config.reasoningSummary,
    reasoningMode: config.reasoningMode,
  };
}

/** Keep process-level overrides transient when an effective config is saved. */
export function withoutEnvironmentOverrides(
  layer: ConfigLayer,
  environmentConfig: ConfigLayer,
): ConfigLayer {
  const result = { ...layer };
  for (const key of Object.keys(environmentConfig)) {
    Reflect.deleteProperty(result, key);
  }
  return result;
}

async function readWritableConfig(filePath: string): Promise<JsonRecord> {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (!isObject(value)) throw new Error("the root value must be a JSON object");
    return value;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return {};
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot update ${filePath}: ${detail}`, { cause: error });
  }
}

/**
 * Merge known setting changes into the dedicated extension file. Unknown keys
 * are retained, and an invalid existing file is never overwritten.
 */
export async function saveConfig(
  cwd: string,
  projectTrusted: boolean,
  patch: ConfigLayer,
): Promise<string> {
  const filePath = writableConfigPath(cwd, projectTrusted);
  const current = await readWritableConfig(filePath);
  const next = { ...current, ...patch };
  const directory = dirname(filePath);
  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  await mkdir(directory, { recursive: true });
  const existingMode = await stat(filePath)
    .then((metadata) => metadata.mode & 0o777)
    .catch((error: unknown) => {
      if (nodeErrorCode(error) === "ENOENT") return 0o600;
      throw error;
    });

  try {
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: existingMode,
    });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }

  return filePath;
}
