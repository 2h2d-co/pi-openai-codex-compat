import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as piAi from "@earendil-works/pi-ai";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  requirePiRuntime,
  type BuiltinModels,
} from "../extensions/openai-codex-compat/pi-runtime.ts";

test("in-process Pi uses the repository dependency's package resources", async () => {
  assert.equal(
    await realpath(piCodingAgent.getPackageDir()),
    await realpath(
      fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent", import.meta.url)),
    ),
  );
});

const builtinModels: BuiltinModels = getBuiltinModels;

test("accepts the Pi 0.99.1 host APIs and model catalog", () => {
  assert.doesNotThrow(() => requirePiRuntime(piAi, piCodingAgent, builtinModels));
});

test("rejects missing host APIs even when package metadata reports Pi 0.99.1", () => {
  assert.throws(
    () => requirePiRuntime({ VERSION: "0.99.1" }, piCodingAgent, builtinModels),
    /requires a running Pi 0\.99\.1 or later runtime.*normalizeContext.*Exit Pi.*\/reload.*PI_PACKAGE_DIR/,
  );
  assert.throws(
    () => requirePiRuntime({ ...piAi, normalizeContext: undefined }, piCodingAgent, builtinModels),
    /Missing host APIs: normalizeContext\./,
  );
  assert.throws(
    () =>
      requirePiRuntime(
        piAi,
        { ...piCodingAgent, buildSessionProjection: undefined },
        builtinModels,
      ),
    /Missing host APIs: buildSessionProjection\./,
  );
});

test("rejects a Pi 0.99.0 host whose built-in Codex catalog lacks GPT-6.1 Sol", () => {
  const pi0990: BuiltinModels = (provider) =>
    getBuiltinModels(provider).filter((model) => model.id !== "gpt-6.1-sol");
  assert.throws(
    () => requirePiRuntime(piAi, piCodingAgent, undefined),
    /catalog lacks gpt-6\.1-sol/,
  );
  assert.throws(
    () => requirePiRuntime(piAi, piCodingAgent, pi0990),
    /requires a running Pi 0\.99\.1 or later runtime\. The host's built-in OpenAI Codex catalog lacks gpt-6\.1-sol\./,
  );
});
