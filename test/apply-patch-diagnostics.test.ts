import {
  requireJsonRecord,
  requireJsonRecords,
} from "../extensions/openai-codex-compat/codex-protocol.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import registerApplyPatch, {
  type ApplyPatchApi,
  type ApplyPatchTool,
} from "../extensions/openai-codex-compat/apply-patch.ts";
import { APPLY_PATCH_DIAGNOSTICS_DIRECTORY } from "../extensions/openai-codex-compat/apply-patch-diagnostics.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function assistantMessage(toolCallId: string, responseId: string): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: toolCallId,
        name: "apply_patch",
        arguments: { patch: "captured separately" },
      },
    ],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-test",
    responseId,
    diagnostics: [
      {
        type: "codex_transport_request",
        timestamp: 1,
        details: {
          turnId: "turn-1",
          threadId: "thread-1",
          windowId: "window-1",
          sessionId: SESSION_ID,
          promptCacheKey: "prompt-key-1",
          cacheIdentity: {
            clientRequestHeader: "request-1",
            sessionHeader: SESSION_ID,
            threadHeader: "thread-1",
          },
        },
      },
    ],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  };
}

function assistantEntry(toolCallId: string, responseId: string): SessionEntry {
  return {
    type: "message",
    id: `entry-${responseId}`,
    parentId: null,
    timestamp: new Date(1).toISOString(),
    message: assistantMessage(toolCallId, responseId),
  };
}

test("captures apply_patch diagnostics without copying binary bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-apply-patch-diagnostics-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(cwd, "source.txt"), "before\n");
  await writeFile(join(cwd, "move-source.txt"), "move before\n");
  await writeFile(join(cwd, "destination.txt"), "destination before\n");
  await writeFile(join(cwd, "binary.dat"), Buffer.from([0xff, 0x00]));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) {
      delete process.env["PI_CODING_AGENT_DIR"];
    } else {
      process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    }
  });

  let registered: ApplyPatchTool | undefined;
  let resultHandler: Parameters<ApplyPatchApi["on"]>[1] | undefined;
  const pi: ApplyPatchApi = {
    registerTool(tool) {
      registered = tool;
    },
    on(_event, handler) {
      resultHandler = handler;
    },
  };
  registerApplyPatch(
    pi,
    () => "subtle",
    () => false,
    () => true,
  );
  assert.ok(registered);
  const tool = registered;
  let branch: SessionEntry[] = [];
  const sessionFile = join(agentDir, "session.jsonl");
  const sessionManager = {
    getBranch: () => branch,
    getSessionFile: () => sessionFile,
    getSessionId: () => SESSION_ID,
  };

  const successCallId = "call-success|item-success";
  branch = [assistantEntry(successCallId, "response-success")];
  const successPatch = `*** Begin Patch
*** Update File: source.txt
@@
-before
+after
*** Update File: move-source.txt
*** Move to: destination.txt
@@
-move before
+move after
*** Delete File: binary.dat
*** Add File: added.txt
+added
*** End Patch`;
  const result = await tool.execute(successCallId, { patch: successPatch }, undefined, undefined, {
    cwd,
    sessionManager,
  });
  const reference = result.details?.diagnostics;
  assert.ok(reference);
  assert.equal(await readFile(join(cwd, "source.txt"), "utf8"), "after\n");
  assert.equal(await readFile(join(cwd, "destination.txt"), "utf8"), "move after\n");

  const diagnosticsMode =
    (await stat(join(agentDir, APPLY_PATCH_DIAGNOSTICS_DIRECTORY))).mode & 0o777;
  const sessionDirectoryMode = (await stat(dirname(reference.requestPath))).mode & 0o777;
  const requestMode = (await stat(reference.requestPath)).mode & 0o777;
  const resultMode = (await stat(reference.resultPath)).mode & 0o777;
  assert.equal(diagnosticsMode, 0o700);
  assert.equal(sessionDirectoryMode, 0o700);
  assert.equal(requestMode, 0o600);
  assert.equal(resultMode, 0o600);
  assert.match(
    reference.requestPath,
    new RegExp(`${APPLY_PATCH_DIAGNOSTICS_DIRECTORY}/${SESSION_ID}/`),
  );

  const requestJson = await readFile(reference.requestPath, "utf8");
  assert.equal(requestJson.includes("/wA="), false);
  const request = requireJsonRecord(JSON.parse(requestJson));
  assert.equal(request["recordId"], reference.recordId);
  assert.equal(request["cwd"], cwd);
  assert.equal(request["patch"], successPatch);
  assert.deepEqual(request["session"], { id: SESSION_ID, file: sessionFile });
  const identifiers = requireJsonRecord(request["request"]);
  assert.equal(identifiers["toolCallId"], successCallId);
  assert.equal(identifiers["providerCallId"], "call-success");
  assert.equal(identifiers["providerItemId"], "item-success");
  assert.equal(identifiers["assistantEntryId"], "entry-response-success");
  assert.equal(identifiers["responseId"], "response-success");
  assert.equal(identifiers["turnId"], "turn-1");
  assert.equal(identifiers["clientRequestId"], "request-1");

  const parsed = requireJsonRecord(request["parsed"]);
  assert.equal(parsed["status"], "parsed");
  assert.equal(requireJsonRecords(parsed["operations"]).length, 4);
  const snapshots = requireJsonRecords(request["snapshots"]);
  const sourceSnapshot = snapshots.find(
    (snapshot) => snapshot["absolutePath"] === join(cwd, "source.txt"),
  );
  const binarySnapshot = snapshots.find(
    (snapshot) => snapshot["absolutePath"] === join(cwd, "binary.dat"),
  );
  const addedSnapshot = snapshots.find(
    (snapshot) => snapshot["absolutePath"] === join(cwd, "added.txt"),
  );
  const destinationSnapshot = snapshots.find(
    (snapshot) => snapshot["absolutePath"] === join(cwd, "destination.txt"),
  );
  assert.equal(
    requireJsonRecord(requireJsonRecord(sourceSnapshot)["entry"])["kind"],
    "regular-file",
  );
  assert.deepEqual(
    requireJsonRecord(requireJsonRecord(requireJsonRecord(sourceSnapshot)["entry"])["content"]),
    {
      encoding: "utf8",
      data: "before\n",
      byteLength: 7,
      sha256: "9160d4be34c8695bd172a76c7c7966587ea5a4d991ad22c87b2b91af54aa9ebb",
    },
  );
  assert.deepEqual(
    requireJsonRecord(requireJsonRecord(requireJsonRecord(binarySnapshot)["entry"])["content"]),
    {
      encoding: "binary",
      byteLength: 2,
      sha256: "ea5dbf9596d187e9500f23e9a680109475341cf4e81f7e043f7d97152c10772f",
    },
  );
  assert.deepEqual(requireJsonRecord(addedSnapshot), {
    absolutePath: join(cwd, "added.txt"),
    references: [{ instruction: 4, role: "destination", patchPath: "added.txt" }],
    entry: { kind: "absent" },
  });
  assert.deepEqual(requireJsonRecord(destinationSnapshot)["references"], [
    {
      instruction: 2,
      role: "destination",
      patchPath: "destination.txt",
    },
  ]);
  assert.deepEqual(
    requireJsonRecord(
      requireJsonRecord(requireJsonRecord(destinationSnapshot)["entry"])["content"],
    ),
    {
      encoding: "utf8",
      data: "destination before\n",
      byteLength: 19,
      sha256: "bc57eb48e8ade639f6eb4a9451ab9929c6cc6d51e6bcae8fbf948ff50733db6d",
    },
  );

  const successOutcome = requireJsonRecord(
    JSON.parse(await readFile(reference.resultPath, "utf8")),
  );
  assert.equal(successOutcome["status"], "completed");
  assert.equal(
    requireJsonRecord(requireJsonRecord(successOutcome["details"])["diagnostics"])["recordId"],
    reference.recordId,
  );

  const failedCallId = "call-failed|item-failed";
  branch = [assistantEntry(failedCallId, "response-failed")];
  await assert.rejects(
    tool.execute(
      failedCallId,
      {
        patch: `*** Begin Patch
*** Update File: source.txt
@@
-missing
+replacement
*** End Patch`,
      },
      undefined,
      undefined,
      { cwd, sessionManager },
    ),
    /Old content was not found/u,
  );
  const failedDetails = resultHandler?.({
    toolName: "apply_patch",
    toolCallId: failedCallId,
  })?.details;
  assert.ok(failedDetails?.diagnostics);
  const failedOutcome = requireJsonRecord(
    JSON.parse(await readFile(failedDetails.diagnostics.resultPath, "utf8")),
  );
  assert.equal(failedOutcome["status"], "failed");
  assert.equal(requireJsonRecord(failedOutcome["details"])["status"], "failed");
  const errorMessage = requireJsonRecord(failedOutcome["error"])["message"];
  assert.ok(typeof errorMessage === "string");
  assert.match(errorMessage, /expected lines/u);

  const malformedCallId = "call-malformed|item-malformed";
  branch = [assistantEntry(malformedCallId, "response-malformed")];
  await assert.rejects(
    tool.execute(
      malformedCallId,
      {
        patch: `*** Begin Patch
*** Update File: source.txt
@@
-after
+never`,
      },
      undefined,
      undefined,
      { cwd, sessionManager },
    ),
    /Patch format error/u,
  );
  const malformedDetails = resultHandler?.({
    toolName: "apply_patch",
    toolCallId: malformedCallId,
  })?.details;
  assert.ok(malformedDetails?.diagnostics);
  const malformedRequest = requireJsonRecord(
    JSON.parse(await readFile(malformedDetails.diagnostics.requestPath, "utf8")),
  );
  const malformedParsed = requireJsonRecord(malformedRequest["parsed"]);
  assert.equal(malformedParsed["status"], "parse-error");
  assert.equal(requireJsonRecords(malformedParsed["instructions"]).length, 1);
  const malformedSnapshots = requireJsonRecords(malformedRequest["snapshots"]);
  assert.equal(malformedSnapshots.length, 1);
  assert.equal(
    requireJsonRecord(requireJsonRecord(malformedSnapshots[0])["entry"])["kind"],
    "regular-file",
  );
});
