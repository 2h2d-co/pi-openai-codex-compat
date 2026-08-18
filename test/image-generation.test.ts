import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import registerImageGeneration, {
  type ImageGenerationApi,
  type ImageGenerationTool,
  normalizeImagePath,
  recentImageUrls,
} from "../extensions/openai-codex-compat/image-generation.ts";
import { DEFAULT_CONFIG } from "../extensions/openai-codex-compat/config.ts";
import type { JsonRecord } from "../extensions/openai-codex-compat/codex-protocol.ts";
import type { CodexJsonRequestOptions } from "../extensions/openai-codex-compat/codex-transport.ts";
import type { CodexToolExecutionContext } from "../extensions/openai-codex-compat/tool-definition-contract.ts";
import { isString } from "../extensions/openai-codex-compat/value-contracts.ts";
import { testTheme } from "./support/test-theme.ts";

const GENERATED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const ANSI_SEQUENCE_PATTERN = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, "gu");

type ImageRenderContext = Parameters<NonNullable<ImageGenerationTool["renderCall"]>>[2];

function stripAnsi(value: string): string {
  return value.replace(ANSI_SEQUENCE_PATTERN, "");
}

function codexModel(): Model<Api> {
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
  } satisfies Model<Api>;
}

test("selects the newest conversation images in chronological order", () => {
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

test("normalizes absolute referenced image paths", () => {
  const base = join(tmpdir(), "pi-codex-images");
  assert.equal(
    normalizeImagePath(`@${join(base, "nested")}${sep}..${sep}input.png`),
    join(base, "input.png"),
  );
  assert.throws(
    () => normalizeImagePath(`nested${sep}..${sep}input.png`),
    /referenced image path must be absolute/,
  );
});

test("executes generation and recent-image edits through Codex Images", async (t) => {
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
    } satisfies SessionEntry,
  ];
  let tool: ImageGenerationTool | undefined;
  const requests: Array<{
    path: string;
    body: JsonRecord;
    options: CodexJsonRequestOptions;
  }> = [];
  const pi: ImageGenerationApi = {
    registerTool(definition: ImageGenerationTool) {
      tool = definition;
    },
    getAllTools: () => [],
  };
  registerImageGeneration(
    pi,
    () => DEFAULT_CONFIG,
    () => DEFAULT_CONFIG.toolBackground,
    async (_model, path, body, options) => {
      requests.push({ path, body: structuredClone(body), options });
      return { created: 1, data: [{ b64_json: GENERATED_PNG }] };
    },
  );
  assert.ok(tool);
  assert.equal(tool.promptSnippet, "Generate new images or edit existing images");
  assert.deepEqual(tool.promptGuidelines, [
    "Use image_gen.imagegen directly to generate new images or edit existing images without reconfirmation unless required source images are unavailable.",
    "For new images, call image_gen.imagegen without referenced_image_paths or num_last_images_to_include.",
    "For image_gen.imagegen edits, use up to five absolute referenced_image_paths when every target is local; otherwise use num_last_images_to_include from 1 to 5, and use read when you need to inspect a local image.",
    "Never pass both image selectors to image_gen.imagegen; ask the user to reattach images when every target cannot be referenced.",
  ]);
  assert.equal(
    createHash("sha256").update(tool.description).digest("hex"),
    "3790cbce76512c668f3d6f7a2d87710c8da768dd5854e36ce233a23f9e95b246",
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
            "Absolute path to a local PNG, JPEG, GIF, or WebP image to include in an edit. Convert relative paths to absolute paths before calling the tool; the file must exist and be readable.",
        },
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  });

  const context = {
    cwd: process.cwd(),
    isProjectTrusted: () => true,
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
  } satisfies CodexToolExecutionContext;
  await assert.rejects(
    tool.execute(
      "call-too-many-paths|fc-too-many-paths",
      {
        prompt: "Edit too many local images.",
        referenced_image_paths: [
          "/tmp/1.png",
          "/tmp/2.png",
          "/tmp/3.png",
          "/tmp/4.png",
          "/tmp/5.png",
          "/tmp/6.png",
        ],
      },
      undefined,
      undefined,
      context,
    ),
    /referenced_image_paths must contain at most 5 paths/,
  );
  for (const count of [0, 6]) {
    await assert.rejects(
      tool.execute(
        `call-invalid-recent-count-${count}|fc-invalid-recent-count-${count}`,
        {
          prompt: "Edit an invalid number of recent images.",
          num_last_images_to_include: count,
        },
        undefined,
        undefined,
        context,
      ),
      /num_last_images_to_include must be between 1 and 5/,
    );
  }
  await assert.rejects(
    tool.execute(
      "call-conflicting-selectors|fc-conflicting-selectors",
      {
        prompt: "Edit with conflicting selectors.",
        referenced_image_paths: ["/tmp/input.png"],
        num_last_images_to_include: 1,
      },
      undefined,
      undefined,
      context,
    ),
    /provide only one of referenced_image_paths or num_last_images_to_include/,
  );
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
  assert.equal(tool.renderShell, "self");
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

  const savedPath = result.details.savedPath;
  assert.ok(isString(savedPath));
  assert.equal(savedPath, join(agentDir, "generated_images", "session-1", "call-image.png"));
  assert.deepEqual(await readFile(savedPath), Buffer.from(GENERATED_PNG, "base64"));
  assert.deepEqual(result.content[0], {
    type: "image",
    data: GENERATED_PNG,
    mimeType: "image/png",
  });
  const outputMessage = result.content[1];
  assert.equal(outputMessage?.type, "text");
  if (outputMessage?.type !== "text") {
    throw new Error("The image-generation result has no text output hint.");
  }
  assert.match(outputMessage.text, /already displayed to the user/);
  assert.match(outputMessage.text, /use the generated image at another path/);

  const theme = testTheme();
  const args = { prompt: "Draw a blue square." };
  const renderContext: ImageRenderContext = {
    args,
    toolCallId: "call-generate|fc-generate",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: "/tmp",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
  };
  const renderCall = tool.renderCall;
  const renderResult = tool.renderResult;
  assert.ok(renderCall);
  assert.ok(renderResult);
  const callText = stripAnsi(renderCall(args, theme, renderContext).render(100).join("\n"));
  assert.match(callText, /image_gen\.imagegen  generate "Draw a blue square\."/);

  const longPrompt = "x".repeat(260);
  const longCallText = stripAnsi(
    renderCall({ prompt: longPrompt }, theme, {
      ...renderContext,
      args: { prompt: longPrompt },
    })
      .render(400)
      .join("\n"),
  );
  assert.match(longCallText, new RegExp(`generate "${"x".repeat(249)}…"`));

  const collapsed = renderResult(
    generated,
    { expanded: false, isPartial: false },
    theme,
    renderContext,
  )
    .render(100)
    .join("\n");
  const collapsedText = stripAnsi(collapsed);
  assert.match(collapsedText, /Generated image/);
  assert.match(collapsedText, /call-generate\.png/);
  assert.doesNotMatch(collapsedText, /already displayed/);
  assert.ok(collapsed.includes("\u001b[48;2;26;26;33m"));

  const expandedText = stripAnsi(
    renderResult(generated, { expanded: true, isPartial: false }, theme, {
      ...renderContext,
      expanded: true,
    })
      .render(100)
      .join("\n"),
  );
  assert.match(expandedText, /Prompt\s+Draw a blue square\./);
  assert.match(expandedText.replace(/\s+/gu, " "), /Saved .*call-generate\.png/);
});
