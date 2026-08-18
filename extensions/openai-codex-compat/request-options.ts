import { calculateCost, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type CodexCompatConfig, type WebSearchMode } from "./config.ts";
import { isObject, type JsonRecord } from "./codex-protocol.ts";
import { splitNamespacedToolName, WEB_RUN_TOOL_NAME } from "./namespaced-tools.ts";

const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";

export function isCodexModel(model: Model<any> | undefined): model is Model<any> {
  return Boolean(model && model.provider === CODEX_PROVIDER && model.api === CODEX_API);
}

export function supportsReasoningMode(modelId: string): boolean {
  return /^gpt-5\.6(?:-|$)/.test(modelId);
}

function isWebSearchTool(value: unknown): boolean {
  return isObject(value) && value.type === "web_search";
}

function isWebRunNamespace(value: unknown): boolean {
  if (!isObject(value) || value.type !== "namespace") return false;
  const webRun = splitNamespacedToolName(WEB_RUN_TOOL_NAME)!;
  return (
    value.name === webRun.namespace &&
    Array.isArray(value.tools) &&
    value.tools.some(
      (tool) => isObject(tool) && tool.type === "function" && tool.name === webRun.name,
    )
  );
}

function webSearchTool(mode: Exclude<WebSearchMode, "disabled">, images: boolean): JsonRecord {
  const tool: JsonRecord = {
    type: "web_search",
    external_web_access: mode !== "cached",
  };
  if (mode === "indexed") tool["indexed_web_access"] = true;
  if (images) tool["search_content_types"] = ["text", "image"];
  return tool;
}

export function applyCodexRequestOptions(
  payload: JsonRecord,
  config: CodexCompatConfig,
  options: { modelId: string; supportsImageSearch: boolean },
): JsonRecord {
  const result = structuredClone(payload);

  if (config.fastMode) result.service_tier = "priority";

  const text = isObject(result.text) ? result.text : {};
  result.text = { ...text, verbosity: config.textVerbosity };

  const reasoning = result["reasoning"];
  if (isObject(reasoning)) {
    const updatedReasoning = { ...reasoning };
    if (config.reasoningSummary === "off") {
      Reflect.deleteProperty(updatedReasoning, "summary");
    } else {
      updatedReasoning["summary"] = config.reasoningSummary;
    }
    if (supportsReasoningMode(options.modelId) && config.reasoningMode === "pro") {
      updatedReasoning["mode"] = "pro";
    } else {
      Reflect.deleteProperty(updatedReasoning, "mode");
    }
    result["reasoning"] = updatedReasoning;
  }

  const tools = Array.isArray(result.tools) ? result.tools : [];
  const toolsWithoutSearch = tools.filter((tool) => !isWebSearchTool(tool));
  if (tools.some(isWebRunNamespace) || config.webSearch === "disabled") {
    if (Array.isArray(result.tools)) result.tools = toolsWithoutSearch;
  } else {
    result.tools = [
      ...toolsWithoutSearch,
      webSearchTool(config.webSearch, options.supportsImageSearch),
    ];
  }

  return result;
}

/** Recompute cost from canonical rates so payload-only priority mode cannot be undercounted. */
export function applyPriorityPricing(
  message: AssistantMessage,
  model: Model<any>,
): AssistantMessage {
  const usage = structuredClone(message.usage);
  calculateCost(model, usage);
  const multiplier = model.id === "gpt-5.5" ? 2.5 : 2;
  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return { ...message, usage };
}

type ConfigResolver = (ctx: ExtensionContext) => CodexCompatConfig;

function resolveFileConfig(ctx: ExtensionContext): CodexCompatConfig {
  return loadConfig(ctx.cwd, ctx.isProjectTrusted());
}

export default function registerCodexRequestOptions(
  pi: ExtensionAPI,
  resolveConfig: ConfigResolver = resolveFileConfig,
): void {
  pi.on("before_provider_request", (event, ctx) => {
    if (!isCodexModel(ctx.model) || !isObject(event.payload)) return undefined;

    const config = resolveConfig(ctx);
    return applyCodexRequestOptions(event.payload, config, {
      modelId: ctx.model!.id,
      supportsImageSearch: ctx.model!.input.includes("image"),
    });
  });
}
