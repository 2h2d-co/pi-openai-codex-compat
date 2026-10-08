import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import {
  sseHeaders,
  websocketHeaders,
  jsonHeaders,
} from "../extensions/openai-codex-compat/codex-transport/codex-transport-request-headers.ts";

const builders = {
  sse: (model: Record<string, string> | undefined, caller: ProviderHeaders | undefined) =>
    sseHeaders(model, caller, "synthetic-account", "synthetic-token", "synthetic-session", {}),
  websocket: (model: Record<string, string> | undefined, caller: ProviderHeaders | undefined) =>
    websocketHeaders(
      model,
      caller,
      "synthetic-account",
      "synthetic-token",
      "synthetic-session",
      {},
    ),
  json: (model: Record<string, string> | undefined, caller: ProviderHeaders | undefined) =>
    jsonHeaders(model, caller, undefined, "synthetic-account", "synthetic-token"),
};

for (const [transport, build] of Object.entries(builders)) {
  test(`${transport} preserves Pi identification defaults`, () => {
    const headers = build(undefined, undefined);
    assert.equal(headers.get("originator"), "pi");
    assert.match(headers.get("user-agent") ?? "", /^pi \(.+\)$/u);
  });

  test(`${transport} applies model then caller identification overrides`, () => {
    const model = { Originator: "model-client", "USER-AGENT": "model-agent" };
    const modelHeaders = build(model, undefined);
    assert.equal(modelHeaders.get("originator"), "model-client");
    assert.equal(modelHeaders.get("user-agent"), "model-agent");
    const caller = {
      originator: "caller-client",
      "user-agent": "caller-agent",
      authorization: "not-the-authentication",
      "chatgpt-account-id": "not-the-account",
    };
    const headers = build(model, caller);
    assert.equal(headers.get("originator"), "caller-client");
    assert.equal(headers.get("user-agent"), "caller-agent");
    assert.equal(headers.get("authorization"), "Bearer synthetic-token");
    assert.equal(headers.get("chatgpt-account-id"), "synthetic-account");
    assert.deepEqual(model, { Originator: "model-client", "USER-AGENT": "model-agent" });
  });

  test(`${transport} permits deletion of identification headers but protects authentication`, () => {
    const headers = build(
      { originator: "model-client", "User-Agent": "model-agent" },
      { originator: null, "user-agent": null, authorization: null, "chatgpt-account-id": null },
    );
    assert.equal(headers.has("originator"), false);
    assert.equal(headers.has("user-agent"), false);
    assert.equal(headers.get("authorization"), "Bearer synthetic-token");
    assert.equal(headers.get("chatgpt-account-id"), "synthetic-account");
  });
}
