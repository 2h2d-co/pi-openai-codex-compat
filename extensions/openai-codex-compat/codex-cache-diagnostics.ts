import { createHash } from "node:crypto";
import { type JsonRecord } from "./codex-protocol.ts";
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
  const staticPrefix = lite
    ? (staticWireBody.input ?? [])
    : {
        ...("instructions" in ordinaryBody ? { instructions: ordinaryBody.instructions } : {}),
        ...("tools" in ordinaryBody ? { tools: ordinaryBody.tools } : {}),
      };
  const prefixFingerprint = jsonFingerprint(staticPrefix);
  const requestFingerprint = jsonFingerprint(staticRequest(staticWireBody));
  const instructionFingerprint =
    typeof ordinaryBody.instructions === "string"
      ? textFingerprint(ordinaryBody.instructions)
      : undefined;
  const toolsFingerprint = Array.isArray(ordinaryBody.tools)
    ? jsonFingerprint(ordinaryBody.tools)
    : undefined;

  return {
    envelope: lite ? "responses_lite" : "responses",
    prewarmMode: "static",
    fullInputItems: inputLength(fullWireBody),
    staticInputItems: inputLength(staticWireBody),
    staticPrefixBytes: prefixFingerprint.bytes,
    staticPrefixSha256: prefixFingerprint.sha256,
    staticRequestBytes: requestFingerprint.bytes,
    staticRequestSha256: requestFingerprint.sha256,
    ...(instructionFingerprint
      ? {
          instructionsBytes: instructionFingerprint.bytes,
          instructionsSha256: instructionFingerprint.sha256,
        }
      : {}),
    ...(toolsFingerprint
      ? {
          toolsBytes: toolsFingerprint.bytes,
          toolsSha256: toolsFingerprint.sha256,
        }
      : {}),
  };
}
