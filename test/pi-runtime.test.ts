import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as piAi from "@earendil-works/pi-ai";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { requirePiRuntime } from "../extensions/openai-codex-compat/pi-runtime.ts";

test("in-process Pi uses the repository dependency's package resources", async () => {
  assert.equal(
    await realpath(piCodingAgent.getPackageDir()),
    await realpath(
      fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent", import.meta.url)),
    ),
  );
});

const extensionApi = { getSettings: () => ({}) };

test("accepts the installed Pi host", () => {
  assert.doesNotThrow(() => requirePiRuntime(piAi, piCodingAgent, extensionApi));
});

test("rejects missing host APIs even when package metadata reports Pi 1.1.0", () => {
  assert.throws(
    () => requirePiRuntime({ VERSION: "1.1.0" }, piCodingAgent, extensionApi),
    /requires a running Pi 1\.1\.0 or later runtime.*normalizeContext.*Exit Pi.*\/reload.*PI_PACKAGE_DIR/,
  );
  assert.throws(
    () => requirePiRuntime({ ...piAi, normalizeContext: undefined }, piCodingAgent, extensionApi),
    /Missing host APIs: normalizeContext\./,
  );
  assert.throws(
    () =>
      requirePiRuntime(piAi, { ...piCodingAgent, buildSessionProjection: undefined }, extensionApi),
    /Missing host APIs: buildSessionProjection\./,
  );
});

test("rejects a Pi 0.87 host surface that reports a newer version", () => {
  class SessionManager087 {}
  assert.throws(
    () => requirePiRuntime(piAi, { ...piCodingAgent, SessionManager: SessionManager087 }, {}),
    /Missing host APIs: SessionManager\.getEntryCount, ExtensionAPI\.getSettings\./,
  );
});

test("rejects Pi versions below 1.1.0", () => {
  for (const version of [
    "0.87.1",
    "0.99.1",
    "0.99.2",
    "1.0.0",
    "1.0.4",
    "1.1.0-rc.1",
    "invalid",
    undefined,
  ]) {
    assert.throws(
      () => requirePiRuntime(piAi, { ...piCodingAgent, VERSION: version }, extensionApi),
      /requires a running Pi 1\.1\.0 or later runtime\. The host reports Pi .*below 1\.1\.0\./,
      String(version),
    );
  }
  for (const version of ["1.1.0", "1.1.1", "1.2.0"]) {
    assert.doesNotThrow(() =>
      requirePiRuntime(piAi, { ...piCodingAgent, VERSION: version }, extensionApi),
    );
  }
});
