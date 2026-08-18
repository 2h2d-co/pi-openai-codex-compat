import { isString } from "./value-contracts.ts";
import { createHash } from "node:crypto";
import { type JsonRecord, type JsonValue } from "./codex-protocol.ts";
import { usesResponsesLite } from "./responses-lite.ts";

type Fingerprint = {
  bytes: number;
  sha256: string;
};

export type CodexCacheDiagnosticContext = {
  envelope: "responses" | "responses_lite";
  prewarmMode: "static";
  fullInputItems: number;
  staticInputItems: number;
  staticPrefixBytes: number;
  staticPrefixSha256: string;
  staticRequestBytes: number;
  staticRequestSha256: string;
  instructionsBytes?: number;
  instructionsSha256?: string;
  toolsBytes?: number;
  toolsSha256?: string;
};

function jsonFingerprint(value: unknown): Fingerprint {
  const json = JSON.stringify(value);
  return {
    bytes: Buffer.byteLength(json, "utf8"),
    sha256: createHash("sha256").update(json, "utf8").digest("hex"),
  };
}

function textFingerprint(value: string): Fingerprint {
  return {
    bytes: Buffer.byteLength(value, "utf8"),
    sha256: createHash("sha256").update(value, "utf8").digest("hex"),
  };
}

function inputLength(payload: JsonRecord): number {
  return Array.isArray(payload.input) ? payload.input.length : 0;
}

function staticRequest(payload: JsonRecord): JsonRecord {
  const result = structuredClone(payload);
  delete result.client_metadata;
  delete result.prompt_cache_key;
  return result;
}

export function codexCacheDiagnosticContext(
  ordinaryBody: JsonRecord,
  fullWireBody: JsonRecord,
  staticWireBody: JsonRecord,
  modelId: string,
  responsesLiteEnabled = true,
): CodexCacheDiagnosticContext {
  const lite = usesResponsesLite(modelId, responsesLiteEnabled);
  let staticPrefix: JsonValue;
  if (lite) {
    staticPrefix = staticWireBody.input ?? [];
  } else {
    const prefix: JsonRecord = {};
    if ("instructions" in ordinaryBody) prefix.instructions = ordinaryBody.instructions;
    if ("tools" in ordinaryBody) prefix.tools = ordinaryBody.tools;
    staticPrefix = prefix;
  }
  const prefixFingerprint = jsonFingerprint(staticPrefix);
  const requestFingerprint = jsonFingerprint(staticRequest(staticWireBody));
  const instructionFingerprint = isString(ordinaryBody.instructions)
    ? textFingerprint(ordinaryBody.instructions)
    : undefined;
  const toolsFingerprint = Array.isArray(ordinaryBody.tools)
    ? jsonFingerprint(ordinaryBody.tools)
    : undefined;

  const context: CodexCacheDiagnosticContext = {
    envelope: lite ? "responses_lite" : "responses",
    prewarmMode: "static",
    fullInputItems: inputLength(fullWireBody),
    staticInputItems: inputLength(staticWireBody),
    staticPrefixBytes: prefixFingerprint.bytes,
    staticPrefixSha256: prefixFingerprint.sha256,
    staticRequestBytes: requestFingerprint.bytes,
    staticRequestSha256: requestFingerprint.sha256,
  };
  if (instructionFingerprint) {
    context.instructionsBytes = instructionFingerprint.bytes;
    context.instructionsSha256 = instructionFingerprint.sha256;
  }
  if (toolsFingerprint) {
    context.toolsBytes = toolsFingerprint.bytes;
    context.toolsSha256 = toolsFingerprint.sha256;
  }
  return context;
}
