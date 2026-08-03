import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
  approximateTokens,
  isObject,
  truncateMiddleWithTokenBudget,
  type JsonRecord,
  type ResponsesItem,
} from "./codex-protocol.ts";
import { requestCodexJson, type CodexJsonRequestOptions } from "./codex-transport.ts";
import type { CodexCompatConfig, WebSearchMode } from "./config.ts";
import { WEB_RUN_TOOL_NAME } from "./namespaced-tools.ts";
import { isCodexModel } from "./request-options.ts";
import { codexToolAuthentication, codexToolHistory } from "./tool-runtime.ts";
import { WEB_RUN_PARAMETERS } from "./web-run-schema.ts";

const SEARCH_ENDPOINT = "alpha/search";
const SEARCH_OUTPUT_TOKEN_BUDGET = 2_500;
const ASSISTANT_CONTEXT_TOKEN_BUDGET = 1_000;

const WEB_RUN_DESCRIPTION = readFileSync(
  new URL("./web-run-description.txt", import.meta.url),
  "utf8",
);

export type WebRunDetails = {
  results?: unknown[];
};

type ConfigResolver = (ctx: ExtensionContext) => CodexCompatConfig;
type JsonRequester = (
  model: Model<any>,
  path: string,
  body: JsonRecord,
  options: CodexJsonRequestOptions,
) => Promise<unknown>;

function visibleMessage(item: ResponsesItem): JsonRecord | undefined {
  if (item.type !== undefined && item.type !== "message") return undefined;
  if (item.role !== "user" && item.role !== "assistant") return undefined;
  if (!Array.isArray(item.content)) return undefined;

  const content = item.content
    .filter(isObject)
    .filter((part) =>
      item.role === "user" ? part.type === "input_text" : part.type === "output_text",
    )
    .filter((part) => typeof part.text === "string")
    .map((part) => ({ type: part.type, text: part.text }));
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
      if (part.type !== "output_text" || typeof part.text !== "string" || remaining === 0) {
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
  requestJson: JsonRequester = requestCodexJson,
): void {
  pi.registerTool({
    name: WEB_RUN_TOOL_NAME,
    label: WEB_RUN_TOOL_NAME,
    description: WEB_RUN_DESCRIPTION,
    parameters: WEB_RUN_PARAMETERS,
    executionMode: "parallel",
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
        ...(input ? { input } : {}),
        commands: params,
        settings: {
          allowed_callers: ["direct"],
          external_web_access: externalWebAccess(config.webSearch),
        },
        max_output_tokens: SEARCH_OUTPUT_TOKEN_BUDGET,
      };
      const response = await requestJson(model, SEARCH_ENDPOINT, body, {
        ...authentication,
        ...(signal ? { signal } : {}),
      });
      if (!isObject(response) || typeof response["output"] !== "string") {
        throw new Error("OpenAI Codex returned an invalid standalone web-search response.");
      }
      const results = Array.isArray(response["results"])
        ? response["results"].map((result) => structuredClone(result))
        : undefined;
      return {
        content: [{ type: "text", text: response["output"] }],
        details: (results ? { results } : {}) satisfies WebRunDetails,
      };
    },
  });
}
