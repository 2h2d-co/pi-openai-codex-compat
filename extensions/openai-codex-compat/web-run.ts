import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
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

const SEARCH_ENDPOINT = "alpha/search";
const SEARCH_OUTPUT_TOKEN_BUDGET = 2_500;
const ASSISTANT_CONTEXT_TOKEN_BUDGET = 1_000;

const WEB_RUN_DESCRIPTION = `Tool for accessing the internet.

Available commands:
- search_query: query the internet search engine.
- image_query: query the image search engine.
- open: open a result reference or URL, optionally at a line number.
- click: open a numbered link from a previously opened page.
- find: locate text within a page.
- screenshot: capture a zero-indexed PDF page.

Use multiple commands in one call when they can run together, and provide only fields needed by each command. A search_query call supports at most four queries; use medium or long response_length when sending more than three.

Use search for current, unstable, niche, or externally sourced information. Prefer authoritative primary sources for technical claims. Use returned reference IDs only in later web.run operations; final answers should cite direct source links rather than exposing reference IDs.`;

const searchQuery = Type.Object(
  {
    q: Type.String({ description: "Search query." }),
    recency: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Filter to results from this many recent days.",
      }),
    ),
    domains: Type.Optional(
      Type.Array(Type.String(), {
        description: "Restrict results to these domains.",
      }),
    ),
  },
  { additionalProperties: false },
);

const webRunParameters = Type.Object(
  {
    search_query: Type.Optional(
      Type.Array(searchQuery, {
        description: "Internet search queries.",
      }),
    ),
    image_query: Type.Optional(
      Type.Array(searchQuery, {
        description: "Image search queries.",
      }),
    ),
    open: Type.Optional(
      Type.Array(
        Type.Object(
          {
            ref_id: Type.String({ description: "Result reference id or URL." }),
            lineno: Type.Optional(
              Type.Integer({
                minimum: 0,
                description: "Line number at which to position the page.",
              }),
            ),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    click: Type.Optional(
      Type.Array(
        Type.Object(
          {
            ref_id: Type.String({ description: "Reference id containing the numbered link." }),
            id: Type.Integer({ minimum: 0, description: "Numbered link id." }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    find: Type.Optional(
      Type.Array(
        Type.Object(
          {
            ref_id: Type.String({ description: "Result reference id or URL." }),
            pattern: Type.String({ description: "Text pattern to find." }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    screenshot: Type.Optional(
      Type.Array(
        Type.Object(
          {
            ref_id: Type.String({ description: "PDF result reference id or URL." }),
            pageno: Type.Integer({
              minimum: 0,
              description: "Zero-indexed PDF page number.",
            }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    response_length: Type.Optional(
      StringEnum(["short", "medium", "long"] as const, {
        description: "Length of the returned search response.",
      }),
    ),
  },
  { additionalProperties: false },
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
    parameters: webRunParameters,
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
