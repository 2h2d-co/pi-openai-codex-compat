import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import registerImageGeneration, {
  recentImageUrls,
} from "../extensions/openai-codex-compat/image-generation.ts";
import type { JsonRecord } from "../extensions/openai-codex-compat/codex-protocol.ts";

const GENERATED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function codexModel(): Model<any> {
  return {
    id: "gpt-test",
    name: "GPT Test",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 100_000,
    maxTokens: 10_000,
  } as Model<any>;
}

void test("selects the newest conversation images in chronological order", () => {
  assert.deepEqual(
    recentImageUrls(
      [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: "data:image/png;base64,first" },
            { type: "input_image", image_url: "data:image/png;base64,second" },
          ],
        },
        {
          type: "function_call",
          id: "fc-1",
          call_id: "call-1",
          name: "image_tool",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call-1",
          output: [{ type: "input_image", image_url: "data:image/png;base64,third" }],
        },
      ],
      2,
    ),
    ["data:image/png;base64,second", "data:image/png;base64,third"],
  );
});

void test("executes generation and recent-image edits through Codex Images", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-codex-images-"));
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) {
      delete process.env["PI_CODING_AGENT_DIR"];
    } else {
      process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    }
    await rm(agentDir, { recursive: true, force: true });
  });

  const branch = [
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [
          { type: "text", text: "Edit this image." },
          { type: "image", data: GENERATED_PNG, mimeType: "image/png" },
        ],
        timestamp: Date.now(),
      },
    } as SessionEntry,
  ];
  let tool: any;
  const requests: Array<{
    path: string;
    body: JsonRecord;
    options: Record<string, unknown>;
  }> = [];
  const pi = {
    registerTool(definition: unknown) {
      tool = definition;
    },
    getAllTools: () => [],
  } as unknown as ExtensionAPI;
  registerImageGeneration(pi, async (_model, path, body, options) => {
    requests.push({ path, body: structuredClone(body), options });
    return { created: 1, data: [{ b64_json: GENERATED_PNG }] };
  });
  assert.equal(
    createHash("sha256").update(tool.description).digest("hex"),
    "77a992a7c90e45fcd11623a1efa34bfd4c7870697e0aa54ce9b28f690877170e",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(tool.parameters)), {
    type: "object",
    properties: {
      num_last_images_to_include: {
        type: ["integer", "null"],
      },
      prompt: {
        type: "string",
      },
      referenced_image_paths: {
        type: ["array", "null"],
        items: {
          type: "string",
          description:
            "A path that is guaranteed to be absolute and normalized (though it is not guaranteed to be canonicalized or exist on the filesystem).\n\nIMPORTANT: When deserializing an `AbsolutePathBuf`, a base path must be set using [AbsolutePathBufGuard::new]. If no base path is set, the deserialization will fail unless the path being deserialized is already absolute.",
        },
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  });

  const context = {
    model: codexModel(),
    sessionManager: {
      getSessionId: () => "session-1",
      getBranch: () => branch,
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "token",
        headers: { "x-test": "value" },
      }),
    },
  } as unknown as ExtensionContext;
  const generated = await tool.execute(
    "call-generate|fc-generate",
    { prompt: "Draw a blue square." },
    undefined,
    undefined,
    context,
  );
  const result = await tool.execute(
    "call-image|fc-image",
    { prompt: "Make it blue.", num_last_images_to_include: 1 },
    undefined,
    undefined,
    context,
  );

  assert.equal(tool.executionMode, "sequential");
  assert.equal(requests[0]?.path, "images/generations");
  assert.equal(requests[0]?.body["images"], undefined);
  assert.equal(requests[0]?.body["model"], "gpt-image-2");
  assert.deepEqual(requests[0]?.options["extraHeaders"], {
    "x-codex-image-turn-id": "call-generate",
  });
  assert.equal(
    generated.details.savedPath,
    join(agentDir, "generated_images", "session-1", "call-generate.png"),
  );

  assert.equal(requests[1]?.path, "images/edits");
  assert.deepEqual(requests[1]?.body["images"], [
    { image_url: `data:image/png;base64,${GENERATED_PNG}` },
  ]);
  assert.equal(requests[1]?.body["model"], "gpt-image-2");
  assert.deepEqual(requests[1]?.options["extraHeaders"], {
    "x-codex-image-turn-id": "call-image",
  });

  const savedPath = result.details.savedPath as string;
  assert.equal(savedPath, join(agentDir, "generated_images", "session-1", "call-image.png"));
  assert.deepEqual(await readFile(savedPath), Buffer.from(GENERATED_PNG, "base64"));
  assert.deepEqual(result.content[0], {
    type: "image",
    data: GENERATED_PNG,
    mimeType: "image/png",
  });
  assert.match(result.content[1]?.text ?? "", /already displayed to the user/);
});
