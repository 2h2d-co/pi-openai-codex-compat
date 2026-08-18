import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Context, Model, Tool, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { CodexProviderRuntime } from "../../extensions/openai-codex-compat/codex-provider.ts";
import type { CodexProviderRuntimeApi } from "../../extensions/openai-codex-compat/codex-provider/codex-provider-runtime.ts";
import type { RuntimeScopeContext } from "../../extensions/openai-codex-compat/codex-provider/codex-provider-contracts.ts";
import {
  DEFAULT_CONFIG,
  type CodexCompatConfig,
} from "../../extensions/openai-codex-compat/config.ts";
import { isObject, type JsonRecord } from "../../extensions/openai-codex-compat/codex-protocol.ts";
import {
  getOpenAICodexWebSocketDebugStats,
  type CodexTransportDiagnostic,
} from "../../extensions/openai-codex-compat/codex-transport.ts";
import { IMAGE_GENERATION_PARAMETERS } from "../../extensions/openai-codex-compat/image-generation-schema.ts";
import { NATIVE_RESPONSE_ENTRY_TYPE } from "../../extensions/openai-codex-compat/native-history.ts";
import { IMAGE_GENERATION_TOOL_NAME } from "../../extensions/openai-codex-compat/namespaced-tools.ts";
import { CHECKPOINT_ENTRY_TYPE } from "../../extensions/openai-codex-compat/compaction-checkpoint.ts";
import {
  CODEX_TURN_METADATA_HEADER,
  responsesCompactionV2Metadata,
} from "../../extensions/openai-codex-compat/codex-metadata.ts";
import {
  CODEX_THREAD_MARKER_ENTRY_TYPE,
  type CodexThreadMarkerData,
} from "../../extensions/openai-codex-compat/codex-thread-lineage.ts";

export type MessageEntry = Extract<SessionEntry, { type: "message" }>;
export type UserMessageEntry = Omit<MessageEntry, "message"> & {
  message: Extract<Context["messages"][number], { role: "user" }>;
};
export type AssistantMessageEntry = Omit<MessageEntry, "message"> & {
  message: AssistantMessage;
};
export type ToolResultMessage = Extract<Context["messages"][number], { role: "toolResult" }>;

export const MANUAL_COMPACTION_METADATA = responsesCompactionV2Metadata(
  "manual",
  "user_requested",
  "standalone_turn",
);

export function codexModel(id = "gpt-test"): Model<Api> {
  return {
    id,
    name: "GPT Test",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 100_000,
    maxTokens: 10_000,
    compat: { supportsOpenAIGrammarTools: true },
  } satisfies Model<Api>;
}

export function userEntry(
  id: string,
  text: string,
  parentId: string | null = null,
): UserMessageEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
  };
}

export function assistantEntry(id: string, parentId: string, text: string): AssistantMessageEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-test",
      responseId: `resp_${id}`,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  };
}

export function textEvents(text: string, responseId = "resp_text"): JsonRecord[] {
  return [
    { type: "response.created", response: { id: responseId } },
    {
      type: "response.output_item.added",
      item: { id: "msg_text", type: "message", role: "assistant", content: [] },
    },
    {
      type: "response.content_part.added",
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", delta: text },
    {
      type: "response.output_item.done",
      item: {
        id: "msg_text",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ];
}

export function responseDecisions(message: AssistantMessage): JsonRecord[] {
  return (message.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.type === "codex_response_decision")
    .map((diagnostic) => diagnostic.details)
    .filter(isObject);
}

export const REPORT_TOOL = {
  name: "report",
  description: "Report a value",
  parameters: Type.Object({ value: Type.String() }),
} satisfies Tool;

export const SAMPLE_GRAMMAR_TOOL = {
  name: "sample_tool",
  description: "Sample tool",
  parameters: Type.Object({ input: Type.String() }),
  constrainedSampling: {
    type: "grammar" as const,
    variants: { openai_lark: "start: /.+/" },
  },
} satisfies Tool;

export function compactionEvents(): JsonRecord[] {
  return [
    {
      type: "response.output_item.done",
      item: { type: "compaction", id: "cmp_1", encrypted_content: "opaque-state" },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_compact",
        status: "completed",
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      },
    },
  ];
}

export function accessToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
    }),
  ).toString("base64url");
  return `${header}.${claims}.signature`;
}

export function createHarness(
  initialBranch: SessionEntry[],
  config: CodexCompatConfig = DEFAULT_CONFIG,
  sessionId = "session-1",
  responseRetryPolicy = { maxRetries: 0, baseDelayMs: 0 },
) {
  let branch = [...initialBranch];
  const customEntries: Array<{ customType: string; data: unknown }> = [];
  const compactions: Array<{ details: unknown; usage: unknown }> = [];
  const pi: CodexProviderRuntimeApi = {
    getAllTools: () => [],
    appendEntry(customType: string, data: unknown) {
      customEntries.push({ customType, data });
      branch.push({
        type: "custom",
        id: `custom-${branch.length}`,
        parentId: branch.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        customType,
        data,
      } satisfies SessionEntry);
    },
  };
  const runtime = new CodexProviderRuntime(
    pi,
    () => config,
    "11111111-1111-4111-8111-111111111111",
    responseRetryPolicy,
  );
  runtime.transport.prewarm = async () => false;
  const manager = {
    getSessionId: () => sessionId,
    getBranch: () => branch,
    getLeafId: () => branch.at(-1)?.id ?? null,
    appendCompaction(
      summary: string,
      firstKeptEntryId: string,
      tokensBefore: number,
      details: unknown,
      fromHook: boolean,
      usage: Usage | undefined,
    ) {
      const id = `compact-${branch.length}`;
      const entry: Extract<SessionEntry, { type: "compaction" }> = {
        type: "compaction",
        id,
        parentId: branch.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        summary,
        firstKeptEntryId,
        tokensBefore,
        details,
        fromHook,
      };
      if (usage !== undefined) entry.usage = usage;
      branch.push(entry);
      compactions.push({ details, usage });
      return id;
    },
  };
  const extensionContext = {
    cwd: process.cwd(),
    hasUI: true,
    sessionManager: manager,
    ui: {
      notify() {},
    },
    isProjectTrusted: () => true,
    getContextUsage: () => ({ tokens: 80_000, contextWindow: 100_000, percent: 80 }),
  } satisfies RuntimeScopeContext;
  runtime.captureScope(extensionContext);
  return {
    runtime,
    extensionContext,
    branch: () => branch,
    customEntries,
    compactions,
  };
}

export function appendToolExchange(
  harness: ReturnType<typeof createHarness>,
  assistant: AssistantMessage,
): ToolResultMessage {
  const toolCall = assistant.content.find((block) => block.type === "toolCall");
  assert.ok(toolCall);
  const assistantId = `assistant-${String(harness.branch().length)}`;
  harness.branch().push({
    type: "message",
    id: assistantId,
    parentId: harness.branch().at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
    message: assistant,
  } satisfies MessageEntry);
  const result: ToolResultMessage = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: "completed" }],
    isError: false,
    timestamp: Date.now(),
  };
  harness.branch().push({
    type: "message",
    id: `result-${String(harness.branch().length)}`,
    parentId: assistantId,
    timestamp: new Date().toISOString(),
    message: result,
  } satisfies MessageEntry);
  harness.runtime.captureScope(harness.extensionContext);
  return result;
}

export {
  assert,
  createHash,
  test,
  Type,
  CodexProviderRuntime,
  DEFAULT_CONFIG,
  isObject,
  getOpenAICodexWebSocketDebugStats,
  IMAGE_GENERATION_PARAMETERS,
  NATIVE_RESPONSE_ENTRY_TYPE,
  IMAGE_GENERATION_TOOL_NAME,
  CHECKPOINT_ENTRY_TYPE,
  CODEX_TURN_METADATA_HEADER,
  responsesCompactionV2Metadata,
  CODEX_THREAD_MARKER_ENTRY_TYPE,
};
export type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  AssistantMessage,
  Context,
  Model,
  Tool,
  CodexCompatConfig,
  JsonRecord,
  CodexTransportDiagnostic,
  CodexThreadMarkerData,
};
