import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  CODEX_WS_REQUEST_START_METADATA_KEY,
  closeOpenAICodexWebSocketSessions,
  CodexTransport,
  CodexTurnState,
  getOpenAICodexWebSocketDebugStats,
  requestCodexJson,
  resetOpenAICodexWebSocketDebugStats,
  resolveCodexApiUrl,
  type CodexContinuationHandle,
  type CodexTransportDiagnostic,
  type CodexTransportFailureDiagnostic,
  type CodexTransportRecoveryDiagnostic,
} from "../../extensions/openai-codex-compat/codex-transport.ts";
import type { JsonRecord } from "../../extensions/openai-codex-compat/codex-protocol.ts";

export function codexModel(): Model<Api> {
  return {
    id: "gpt-test",
    name: "GPT Test",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 100_000,
    maxTokens: 10_000,
  } satisfies Model<Api>;
}

export function accessToken(accountId = "account-1"): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `${header}.${claims}.signature`;
}

export function transportFailure(
  diagnostic: CodexTransportDiagnostic | undefined,
): CodexTransportFailureDiagnostic {
  assert.ok(diagnostic);
  if (diagnostic.type !== "provider_transport_failure") {
    assert.fail(`Expected a transport failure diagnostic, received ${diagnostic.type}`);
  }
  return diagnostic;
}

export function transportRecovery(
  diagnostic: CodexTransportDiagnostic | undefined,
): CodexTransportRecoveryDiagnostic {
  assert.ok(diagnostic);
  if (diagnostic.type !== "codex_transport_recovery") {
    assert.fail(`Expected a transport recovery diagnostic, received ${diagnostic.type}`);
  }
  return diagnostic;
}

export function rawMessageItem(id: string, text: string): JsonRecord {
  return {
    id,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ text, type: "output_text", annotations: [] }],
  };
}

export function canonicalMessageItem(id: string, text: string): JsonRecord {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
    status: "completed",
    id,
  };
}

export {
  assert,
  createHash,
  test,
  CODEX_WS_REQUEST_START_METADATA_KEY,
  closeOpenAICodexWebSocketSessions,
  CodexTransport,
  CodexTurnState,
  getOpenAICodexWebSocketDebugStats,
  requestCodexJson,
  resetOpenAICodexWebSocketDebugStats,
  resolveCodexApiUrl,
};
export type {
  Model,
  CodexContinuationHandle,
  CodexTransportDiagnostic,
  CodexTransportFailureDiagnostic,
  CodexTransportRecoveryDiagnostic,
  JsonRecord,
};
