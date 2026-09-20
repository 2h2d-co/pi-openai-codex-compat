import assert from "node:assert/strict";
import test from "node:test";
import * as piAi from "@earendil-works/pi-ai";
import { requirePiTranscriptRuntime } from "../extensions/openai-codex-compat/pi-runtime.ts";

test("accepts the Pi 0.86 transcript runtime", () => {
  assert.doesNotThrow(() => requirePiTranscriptRuntime(piAi));
});

test("rejects missing host APIs even when package metadata reports Pi 0.86", () => {
  assert.throws(
    () => requirePiTranscriptRuntime({ VERSION: "0.86.0" }),
    /requires a running Pi 0\.86\.x.*normalizeContext.*Exit Pi.*\/reload.*PI_PACKAGE_DIR/,
  );
  assert.throws(
    () => requirePiTranscriptRuntime({ ...piAi, normalizeContext: undefined }),
    /Missing host APIs: normalizeContext\./,
  );
});
