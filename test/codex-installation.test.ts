import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CODEX_INSTALLATION_ID_FILE,
  resolveCodexInstallationId,
} from "../extensions/openai-codex-compat/codex-installation.ts";

void test("persists and reuses a Codex installation id", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-openai-codex-compat-installation-"));
  const first = resolveCodexInstallationId(agentDir);
  const second = resolveCodexInstallationId(agentDir);
  const path = join(agentDir, CODEX_INSTALLATION_ID_FILE);

  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(second, first);
  assert.equal(readFileSync(path, "utf8").trim(), first);
  assert.equal(statSync(path).mode & 0o777, 0o644);
});
