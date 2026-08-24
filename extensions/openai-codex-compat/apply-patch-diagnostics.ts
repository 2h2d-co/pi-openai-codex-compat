import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  ApplyPatchDetails,
  ApplyPatchDiagnosticsReference,
  PatchOperation,
} from "./apply-patch-engine.ts";
import {
  parsePatchDocument,
  scanPatchInstructions,
} from "./apply-patch-engine/apply-patch-engine-parser.ts";
import { isObject } from "./codex-protocol.ts";
import { nodeErrorCode } from "./value-contracts.ts";

export const APPLY_PATCH_DIAGNOSTICS_DIRECTORY = "openai-codex-compat-apply-patch-diagnostics";
export const APPLY_PATCH_DIAGNOSTICS_SCHEMA_VERSION = 1;

type ApplyPatchDiagnosticsSessionManager = Pick<
  ExtensionContext["sessionManager"],
  "getBranch" | "getSessionFile" | "getSessionId"
>;

export type ApplyPatchDiagnosticsContext = {
  cwd: string;
  sessionManager: ApplyPatchDiagnosticsSessionManager;
};

type DiagnosticError = {
  name: string;
  message: string;
  stack?: string;
  code?: string;
};

type SnapshotContent =
  | {
      encoding: "binary";
      byteLength: number;
      sha256: string;
    }
  | {
      encoding: "utf8";
      data: string;
      byteLength: number;
      sha256: string;
    };

type SnapshotReference = {
  instruction: number;
  role: "destination" | "source";
  patchPath: string;
};

type FileSnapshot = {
  absolutePath: string;
  references: SnapshotReference[];
  entry:
    | { kind: "absent" }
    | { kind: "directory"; mode: number; modifiedMs: number }
    | {
        kind: "regular-file";
        mode: number;
        modifiedMs: number;
        content: SnapshotContent;
      }
    | {
        kind: "symlink";
        mode: number;
        modifiedMs: number;
        target: string;
        resolvedTarget: string;
        content?: SnapshotContent;
        contentError?: DiagnosticError;
      }
    | { kind: "unsupported"; mode: number; modifiedMs: number }
    | { kind: "inspection-error"; error: DiagnosticError };
};

export type ApplyPatchDiagnosticsOutcome = {
  status: "failed";
  durationMs: number;
  error: DiagnosticError;
  details?: ApplyPatchDetails;
};

export type PreparedApplyPatchDiagnostics = {
  diagnosticsDirectory: string;
  directory: string;
  reference: ApplyPatchDiagnosticsReference;
  request: Record<string, unknown> & { snapshots: FileSnapshot[] };
};

function diagnosticError(error: unknown): DiagnosticError {
  if (!(error instanceof Error)) {
    return {
      name: "NonErrorThrown",
      message: String(error),
    };
  }
  const diagnostic: DiagnosticError = {
    name: error.name,
    message: error.message,
  };
  if (error.stack) diagnostic.stack = error.stack;
  const code = nodeErrorCode(error);
  if (code) diagnostic.code = code;
  return diagnostic;
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^0-9A-Za-z._-]/gu, "_");
  return safe || "unknown-session";
}

function snapshotContent(content: Buffer): SnapshotContent {
  const metadata = {
    byteLength: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  try {
    return {
      encoding: "utf8",
      data: new TextDecoder("utf-8", { fatal: true }).decode(content),
      ...metadata,
    };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return {
      encoding: "binary",
      ...metadata,
    };
  }
}

async function fileSnapshot(
  absolutePath: string,
  references: SnapshotReference[],
): Promise<FileSnapshot> {
  try {
    const metadata = await lstat(absolutePath);
    const mode = metadata.mode & 0o7777;
    if (metadata.isFile()) {
      return {
        absolutePath,
        references,
        entry: {
          kind: "regular-file",
          mode,
          modifiedMs: metadata.mtimeMs,
          content: snapshotContent(await readFile(absolutePath)),
        },
      };
    }
    if (metadata.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      const resolvedTarget = isAbsolute(target)
        ? resolve(target)
        : resolve(dirname(absolutePath), target);
      const entry: Extract<FileSnapshot["entry"], { kind: "symlink" }> = {
        kind: "symlink",
        mode,
        modifiedMs: metadata.mtimeMs,
        target,
        resolvedTarget,
      };
      try {
        entry.content = snapshotContent(await readFile(absolutePath));
      } catch (error) {
        entry.contentError = diagnosticError(error);
      }
      return { absolutePath, references, entry };
    }
    return {
      absolutePath,
      references,
      entry: metadata.isDirectory()
        ? { kind: "directory", mode, modifiedMs: metadata.mtimeMs }
        : { kind: "unsupported", mode, modifiedMs: metadata.mtimeMs },
    };
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return { absolutePath, references, entry: { kind: "absent" } };
    }
    return {
      absolutePath,
      references,
      entry: { kind: "inspection-error", error: diagnosticError(error) },
    };
  }
}

function diagnosticOperations(patch: string):
  | { status: "parsed"; operations: PatchOperation[] }
  | {
      status: "parse-error";
      error: DiagnosticError;
      instructions: ReturnType<typeof scanPatchInstructions>;
    } {
  try {
    return {
      status: "parsed",
      operations: parsePatchDocument(patch).operations,
    };
  } catch (error) {
    return {
      status: "parse-error",
      error: diagnosticError(error),
      instructions: scanPatchInstructions(patch),
    };
  }
}

function snapshotReferences(
  cwd: string,
  parsed: ReturnType<typeof diagnosticOperations>,
): Map<string, SnapshotReference[]> {
  const paths = new Map<string, SnapshotReference[]>();
  const add = (instruction: number, role: SnapshotReference["role"], patchPath: string): void => {
    const absolutePath = isAbsolute(patchPath) ? resolve(patchPath) : resolve(cwd, patchPath);
    const references = paths.get(absolutePath) ?? [];
    references.push({ instruction, role, patchPath });
    paths.set(absolutePath, references);
  };

  if (parsed.status === "parsed") {
    for (const [index, operation] of parsed.operations.entries()) {
      add(index + 1, operation.kind === "add" ? "destination" : "source", operation.path);
      if (operation.kind === "update" && operation.moveTo) {
        add(index + 1, "destination", operation.moveTo);
      }
    }
  } else {
    for (const instruction of parsed.instructions) {
      add(
        instruction.index,
        instruction.kind === "add" ? "destination" : "source",
        instruction.path,
      );
      if (instruction.moveTo) add(instruction.index, "destination", instruction.moveTo);
    }
  }
  return paths;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function requestIdentifiers(
  context: ApplyPatchDiagnosticsContext,
  toolCallId: string,
): Record<string, unknown> {
  const separator = toolCallId.indexOf("|");
  const identifiers: Record<string, unknown> = {
    toolCallId,
    providerCallId: separator < 0 ? toolCallId : toolCallId.slice(0, separator),
  };
  if (separator >= 0 && separator < toolCallId.length - 1) {
    identifiers["providerItemId"] = toolCallId.slice(separator + 1);
  }

  for (const entry of context.sessionManager.getBranch().toReversed()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const hasCall = entry.message.content.some(
      (block) => block.type === "toolCall" && block.id === toolCallId,
    );
    if (!hasCall) continue;

    identifiers["assistantEntryId"] = entry.id;
    identifiers["provider"] = entry.message.provider;
    identifiers["api"] = entry.message.api;
    identifiers["model"] = entry.message.model;
    if (entry.message.responseId) identifiers["responseId"] = entry.message.responseId;

    const transportDiagnostic = entry.message.diagnostics?.findLast(
      (diagnostic) => diagnostic.type === "codex_transport_request",
    );
    if (!isObject(transportDiagnostic?.details)) break;
    const details = transportDiagnostic.details;
    for (const key of [
      "turnId",
      "threadId",
      "windowId",
      "sessionId",
      "promptCacheKey",
      "previousResponseId",
    ]) {
      const value = optionalString(details, key);
      if (value !== undefined) identifiers[key] = value;
    }
    if (isObject(details["cacheIdentity"])) {
      const cacheIdentity = details["cacheIdentity"];
      for (const [source, target] of [
        ["clientRequestHeader", "clientRequestId"],
        ["sessionHeader", "sessionHeader"],
        ["threadHeader", "threadHeader"],
      ] as const) {
        const value = optionalString(cacheIdentity, source);
        if (value !== undefined) identifiers[target] = value;
      }
    }
    break;
  }
  return identifiers;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function prepareApplyPatchDiagnostics(
  context: ApplyPatchDiagnosticsContext,
  toolCallId: string,
  patch: string,
  agentDir = getAgentDir(),
): Promise<PreparedApplyPatchDiagnostics> {
  const capturedAt = new Date().toISOString();
  const recordId = randomUUID();
  const sessionId = context.sessionManager.getSessionId();
  const diagnosticsDirectory = join(agentDir, APPLY_PATCH_DIAGNOSTICS_DIRECTORY);
  const directory = join(diagnosticsDirectory, safePathSegment(sessionId));

  const prefix = `${capturedAt.replace(/[:.]/gu, "-")}_${recordId}`;
  const requestPath = join(directory, `${prefix}.request.json`);
  const resultPath = join(directory, `${prefix}.result.json`);
  const parsed = diagnosticOperations(patch);
  const snapshots = await Promise.all(
    [...snapshotReferences(context.cwd, parsed)].map(([path, references]) =>
      fileSnapshot(path, references),
    ),
  );
  const sessionFile = context.sessionManager.getSessionFile();
  const request = {
    schemaVersion: APPLY_PATCH_DIAGNOSTICS_SCHEMA_VERSION,
    recordId,
    capturedAt,
    cwd: context.cwd,
    session: {
      id: sessionId,
      ...(sessionFile ? { file: sessionFile } : {}),
    },
    request: requestIdentifiers(context, toolCallId),
    patch,
    parsed,
    snapshots,
  };
  return {
    diagnosticsDirectory,
    directory,
    reference: { recordId, requestPath, resultPath },
    request,
  };
}

export async function writeApplyPatchDiagnosticsRequest(
  prepared: PreparedApplyPatchDiagnostics,
): Promise<void> {
  await privateDirectory(prepared.diagnosticsDirectory);
  await privateDirectory(prepared.directory);
  await writePrivateJson(prepared.reference.requestPath, prepared.request);
}

export async function writeApplyPatchDiagnosticsOutcome(
  reference: ApplyPatchDiagnosticsReference,
  outcome: ApplyPatchDiagnosticsOutcome,
): Promise<void> {
  await writePrivateJson(reference.resultPath, {
    schemaVersion: APPLY_PATCH_DIAGNOSTICS_SCHEMA_VERSION,
    recordId: reference.recordId,
    completedAt: new Date().toISOString(),
    ...outcome,
  });
}

export function applyPatchDiagnosticError(error: unknown): DiagnosticError {
  return diagnosticError(error);
}
