import assert from "node:assert/strict";
import {
  requireJsonRecords,
  type JsonRecord,
} from "../../extensions/openai-codex-compat/codex-protocol.ts";
import { isString } from "../../extensions/openai-codex-compat/value-contracts.ts";

/**
 * Read a Codex request as sent the way the extension builds it: with the system prompt in
 * `instructions` and the rest of the input in place. On the wire the prompt is the first
 * developer message in `input`, after Responses Lite's `additional_tools`, and the request has
 * no top-level `instructions`. A request without a prompt reads as an empty `instructions`.
 */
export function withPromptAsInstructions(body: JsonRecord): JsonRecord {
  assert.equal(body["instructions"], undefined, "A Codex request sends no top-level instructions.");
  const input = requireJsonRecords(body["input"]);
  const index = input[0]?.["type"] === "additional_tools" ? 1 : 0;
  const item = input[index];
  if (item?.["type"] !== "message" || item["role"] !== "developer") {
    return { ...body, instructions: "" };
  }
  const content = requireJsonRecords(item["content"]);
  assert.equal(content.length, 1);
  assert.equal(content[0]?.["type"], "input_text");
  const text = content[0]?.["text"];
  assert.ok(isString(text));
  return {
    ...body,
    instructions: text,
    input: input.filter((_, position) => position !== index),
  };
}
