import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const CODEX_INSTALLATION_ID_FILE = "openai-codex-compat-installation-id";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readInstallationId(path: string): string {
  const value = readFileSync(path, "utf8").trim();
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`Invalid Codex installation id in ${path}`);
  }
  return value;
}

export function resolveCodexInstallationId(agentDir = getAgentDir()): string {
  const path = join(agentDir, CODEX_INSTALLATION_ID_FILE);
  try {
    return readInstallationId(path);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }

  mkdirSync(agentDir, { recursive: true });
  const installationId = randomUUID();
  try {
    writeFileSync(path, `${installationId}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    return installationId;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      return readInstallationId(path);
    }
    throw error;
  }
}
