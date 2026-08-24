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

test("persists complete failed-call diagnostics without copying binary bytes", async (t) => {
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
*** End Patch`;
  const result = await tool.execute(successCallId, { patch: successPatch }, undefined, undefined, {
    cwd,
    sessionManager,
  });
  assert.equal(result.details?.diagnostics, undefined);
  assert.equal(await readFile(join(cwd, "source.txt"), "utf8"), "after\n");
  await assert.rejects(stat(join(agentDir, APPLY_PATCH_DIAGNOSTICS_DIRECTORY)), {
    code: "ENOENT",
  });

  const failedCallId = "call-failed|item-failed";
  branch = [assistantEntry(failedCallId, "response-failed")];
  const failedPatch = `*** Begin Patch
*** Update File: source.txt
@@
-after
+not applied
*** Update File: move-source.txt
*** Move to: destination.txt
@@
-missing
+move after
*** Delete File: binary.dat
*** End Patch`;
  await assert.rejects(
    tool.execute(failedCallId, { patch: failedPatch }, undefined, undefined, {
      cwd,
      sessionManager,
    }),
    /Old content was not found/u,
  );
  const failedDetails = resultHandler?.({
    toolName: "apply_patch",
    toolCallId: failedCallId,
  })?.details;
  const reference = failedDetails?.diagnostics;
  assert.ok(reference);
  assert.equal(await readFile(join(cwd, "source.txt"), "utf8"), "after\n");
  assert.equal(await readFile(join(cwd, "move-source.txt"), "utf8"), "move before\n");
  assert.equal(await readFile(join(cwd, "destination.txt"), "utf8"), "destination before\n");
  assert.deepEqual(await readFile(join(cwd, "binary.dat")), Buffer.from([0xff, 0x00]));

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
  assert.equal(request["patch"], failedPatch);
  assert.deepEqual(request["session"], { id: SESSION_ID, file: sessionFile });
  const identifiers = requireJsonRecord(request["request"]);
  assert.equal(identifiers["toolCallId"], failedCallId);
  assert.equal(identifiers["providerCallId"], "call-failed");
  assert.equal(identifiers["providerItemId"], "item-failed");
  assert.equal(identifiers["assistantEntryId"], "entry-response-failed");
  assert.equal(identifiers["responseId"], "response-failed");
  assert.equal(identifiers["turnId"], "turn-1");
  assert.equal(identifiers["clientRequestId"], "request-1");

  const parsed = requireJsonRecord(request["parsed"]);
  assert.equal(parsed["status"], "parsed");
  assert.equal(requireJsonRecords(parsed["operations"]).length, 3);
  const snapshots = requireJsonRecords(request["snapshots"]);
  const precedingSourceSnapshot = snapshots.find(
    (snapshot) => snapshot["absolutePath"] === join(cwd, "source.txt"),
  );
  const sourceSnapshot = snapshots.find(
    (snapshot) => snapshot["absolutePath"] === join(cwd, "move-source.txt"),
  );
  const destinationSnapshot = snapshots.find(
    (snapshot) => snapshot["absolutePath"] === join(cwd, "destination.txt"),
  );
  const binarySnapshot = snapshots.find(
    (snapshot) => snapshot["absolutePath"] === join(cwd, "binary.dat"),
  );
  assert.equal(snapshots.length, 4);
  assert.deepEqual(
    requireJsonRecord(
      requireJsonRecord(requireJsonRecord(precedingSourceSnapshot)["entry"])["content"],
    ),
    {
      encoding: "utf8",
      data: "after\n",
      byteLength: 6,
      sha256: "7b9a72466d3960eb2aacccfc848939453490db0678bd4725def3f789b891c919",
    },
  );
  assert.equal(
    requireJsonRecord(requireJsonRecord(sourceSnapshot)["entry"])["kind"],
    "regular-file",
  );
  assert.deepEqual(
    requireJsonRecord(requireJsonRecord(requireJsonRecord(sourceSnapshot)["entry"])["content"]),
    {
      encoding: "utf8",
      data: "move before\n",
      byteLength: 12,
      sha256: "4e47f0522a6f79adb3f99af8dbc3f80e1066ca4f950921adedc983cf9b813685",
    },
  );
  assert.deepEqual(requireJsonRecord(sourceSnapshot)["references"], [
    {
      instruction: 2,
      role: "source",
      patchPath: "move-source.txt",
    },
  ]);
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
  assert.deepEqual(
    requireJsonRecord(requireJsonRecord(requireJsonRecord(binarySnapshot)["entry"])["content"]),
    {
      encoding: "binary",
      byteLength: 2,
      sha256: "ea5dbf9596d187e9500f23e9a680109475341cf4e81f7e043f7d97152c10772f",
    },
  );

  const failedOutcome = requireJsonRecord(JSON.parse(await readFile(reference.resultPath, "utf8")));
  assert.equal(failedOutcome["status"], "failed");
  assert.equal(
    requireJsonRecord(requireJsonRecord(failedOutcome["details"])["diagnostics"])["recordId"],
    reference.recordId,
  );
  const errorMessage = requireJsonRecord(failedOutcome["error"])["message"];
  assert.ok(typeof errorMessage === "string");
  assert.match(errorMessage, /expected lines/u);

  const binaryCallId = "call-binary|item-binary";
  branch = [assistantEntry(binaryCallId, "response-binary")];
  await assert.rejects(
    tool.execute(
      binaryCallId,
      {
        patch: `*** Begin Patch
*** Update File: binary.dat
@@
-missing
+replacement
*** End Patch`,
      },
      undefined,
      undefined,
      { cwd, sessionManager },
    ),
    /utf-8/iu,
  );
  const binaryDetails = resultHandler?.({
    toolName: "apply_patch",
    toolCallId: binaryCallId,
  })?.details;
  assert.ok(binaryDetails?.diagnostics);
  const binaryRequestJson = await readFile(binaryDetails.diagnostics.requestPath, "utf8");
  assert.equal(binaryRequestJson.includes("/wA="), false);
  const binaryRequest = requireJsonRecord(JSON.parse(binaryRequestJson));
  const binarySnapshots = requireJsonRecords(binaryRequest["snapshots"]);
  assert.equal(binarySnapshots.length, 1);
  assert.deepEqual(
    requireJsonRecord(requireJsonRecord(requireJsonRecord(binarySnapshots[0])["entry"])["content"]),
    {
      encoding: "binary",
      byteLength: 2,
      sha256: "ea5dbf9596d187e9500f23e9a680109475341cf4e81f7e043f7d97152c10772f",
    },
  );

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
