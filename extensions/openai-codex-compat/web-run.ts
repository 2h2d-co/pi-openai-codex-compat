import { isString } from "./value-contracts.ts";
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
  approximateTokens,
  isObject,
  truncateMiddleWithTokenBudget,
  type JsonRecord,
  type JsonValue,
  type ResponsesItem,
} from "./codex-protocol.ts";
import { requestCodexJson, type CodexJsonRequestOptions } from "./codex-transport.ts";
import type { CodexCompatConfig, WebSearchMode } from "./config.ts";
import type { CodexToolBackgroundResolver } from "./codex-tool-surface.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { WEB_RUN_TOOL_NAME } from "./namespaced-tools.ts";
import { isCodexModel } from "./request-options.ts";
import { codexToolAuthentication, codexToolHistory } from "./tool-runtime.ts";
import { renderWebRunCall, renderWebRunResult, type WebRunDetails } from "./web-run-render.ts";
import { WEB_RUN_PARAMETERS } from "./web-run-schema.ts";

const SEARCH_ENDPOINT = "alpha/search";
const SEARCH_OUTPUT_TOKEN_BUDGET = 2_500;
const ASSISTANT_CONTEXT_TOKEN_BUDGET = 1_000;

const WEB_RUN_DESCRIPTION = readFileSync(
  new URL("./web-run-description.txt", import.meta.url),
  "utf8",
);

export type { WebRunDetails } from "./web-run-render.ts";

type ConfigResolver = (ctx: ExtensionContext) => CodexCompatConfig;
type JsonRequester = (
  model: Model<any>,
  path: string,
  body: JsonRecord,
  options: CodexJsonRequestOptions,
) => Promise<JsonValue>;

function visibleMessage(item: ResponsesItem): JsonRecord | undefined {
  if (item.type !== undefined && item.type !== "message") return undefined;
  if (item.role !== "user" && item.role !== "assistant") return undefined;
  if (!Array.isArray(item.content)) return undefined;

  const content: JsonRecord[] = [];
  const expectedType = item.role === "user" ? "input_text" : "output_text";
  for (const part of item.content) {
    if (isObject(part) && part.type === expectedType && isString(part.text)) {
      content.push({ type: expectedType, text: part.text });
    }
  }
  if (content.length === 0) return undefined;
  return { type: "message", role: item.role, content };
}

function truncateAssistantMessages(messages: JsonRecord[]): JsonRecord[] {
  let remaining = ASSISTANT_CONTEXT_TOKEN_BUDGET;
  const result: JsonRecord[] = [];

  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      result.push(message);
      continue;
    }

    const content: JsonRecord[] = [];
    for (const part of message.content.filter(isObject)) {
      if (part.type !== "output_text" || !isString(part.text) || remaining === 0) {
        continue;
      }
      const tokens = approximateTokens(part.text);
      if (tokens <= remaining) {
        content.push(part);
        remaining -= tokens;
      } else {
        content.push({
          ...part,
          text: truncateMiddleWithTokenBudget(part.text, remaining),
        });
        remaining = 0;
      }
    }
    if (content.length > 0) result.push({ ...message, content });
  }
  return result;
}

/** Build the same two-user-turn text tail used by standalone Codex search. */
export function recentSearchInput(history: readonly ResponsesItem[]): JsonRecord[] | undefined {
  const visible = history.map(visibleMessage).filter((item): item is JsonRecord => Boolean(item));
  const latestUser = visible.findLastIndex((item) => item.role === "user");
  if (latestUser < 0) return undefined;

  const throughLatestUser = visible.slice(0, latestUser + 1);
  const userIndexes = throughLatestUser
    .map((item, index) => (item.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  const start = userIndexes.at(-2) ?? userIndexes.at(-1);
  if (start === undefined) return undefined;
  return truncateAssistantMessages(throughLatestUser.slice(start));
}

function externalWebAccess(mode: WebSearchMode): boolean | "indexed" {
  if (mode === "live") return true;
  if (mode === "indexed") return "indexed";
  return false;
}

export default function registerWebRun(
  pi: ExtensionAPI,
  resolveConfig: ConfigResolver,
  resolveToolBackground: CodexToolBackgroundResolver = () => DEFAULT_CONFIG.toolBackground,
  requestJson: JsonRequester = requestCodexJson,
): void {
  pi.registerTool({
    name: WEB_RUN_TOOL_NAME,
    label: WEB_RUN_TOOL_NAME,
    description: WEB_RUN_DESCRIPTION,
    promptSnippet: "Search and browse the internet",
    promptGuidelines: [
      "Use `web.run` when the user explicitly asks to browse or when answering requires current, niche, high-stakes, or precisely sourced information, including recommendations that may change over time.",
      'Batch independent `web.run` operations in one call, pass only required parameters, and keep `search_query` to at most four queries; use `response_length: "medium"` or `"long"` when sending four.',
      "For technical research, prefer primary sources; for OpenAI product questions, inspect local code first and restrict fallback browsing to official OpenAI sites.",
      "Cite supported claims with direct Markdown links near the relevant text, never expose internal reference IDs, and respect the description's quotation and source word limits.",
    ],
    parameters: WEB_RUN_PARAMETERS,
    executionMode: "parallel",
    renderShell: "self",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const model = ctx.model;
      if (!isCodexModel(model)) {
        throw new Error("web.run is available only with an OpenAI Codex model.");
      }
      const authentication = await codexToolAuthentication(ctx, model);
      const config = resolveConfig(ctx);
      const history = codexToolHistory(pi, ctx, model, config.imageDetail);
      const input = recentSearchInput(history);
      const body: JsonRecord = {
        id: ctx.sessionManager.getSessionId(),
        model: model.id,
        commands: params,
        settings: {
          allowed_callers: ["direct"],
          external_web_access: externalWebAccess(config.webSearch),
        },
        max_output_tokens: SEARCH_OUTPUT_TOKEN_BUDGET,
      };
      if (input) body.input = input;
      const requestOptions = { ...authentication };
      if (signal) Object.assign(requestOptions, { signal });
      const response = await requestJson(model, SEARCH_ENDPOINT, body, requestOptions);
      if (!isObject(response) || !isString(response["output"])) {
        throw new Error("OpenAI Codex returned an invalid standalone web-search response.");
      }
      const results = Array.isArray(response["results"])
        ? response["results"].map((result) => structuredClone(result))
        : undefined;
      const details: WebRunDetails = {};
      if (results) details.results = results;
      return {
        content: [{ type: "text", text: response["output"] }],
        details,
      };
    },
    renderCall(args, theme, context) {
      return renderWebRunCall(args, theme, context, resolveToolBackground);
    },
    renderResult(result, options, theme, context) {
      return renderWebRunResult(result, options, theme, context, resolveToolBackground);
    },
  });
}
