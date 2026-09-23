import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as piAi from "@earendil-works/pi-ai";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { requirePiTranscriptRuntime } from "../extensions/openai-codex-compat/pi-runtime.ts";

test("in-process Pi uses the repository dependency's package resources", async () => {
  assert.equal(
    await realpath(piCodingAgent.getPackageDir()),
    await realpath(
      fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent", import.meta.url)),
    ),
  );
});

test("accepts the Pi 0.87 transcript and session runtime", () => {
  assert.doesNotThrow(() => requirePiTranscriptRuntime(piAi, piCodingAgent));
});

test("rejects missing host APIs even when package metadata reports Pi 0.87", () => {
  assert.throws(
    () => requirePiTranscriptRuntime({ VERSION: "0.87.0" }, piCodingAgent),
    /requires a running Pi 0\.87\.x.*normalizeContext.*Exit Pi.*\/reload.*PI_PACKAGE_DIR/,
  );
  assert.throws(
    () => requirePiTranscriptRuntime({ ...piAi, normalizeContext: undefined }, piCodingAgent),
    /Missing host APIs: normalizeContext\./,
  );
  assert.throws(
    () => requirePiTranscriptRuntime(piAi, { ...piCodingAgent, buildSessionProjection: undefined }),
    /Missing host APIs: buildSessionProjection\./,
  );
});
