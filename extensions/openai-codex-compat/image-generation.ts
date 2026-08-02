import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { isObject, type JsonRecord, type ResponsesItem } from "./codex-protocol.ts";
import { requestCodexJson, type CodexJsonRequestOptions } from "./codex-transport.ts";
import { IMAGE_GENERATION_TOOL_NAME } from "./namespaced-tools.ts";
import { isCodexModel } from "./request-options.ts";
import { codexToolAuthentication, codexToolHistory } from "./tool-runtime.ts";

const IMAGE_MODEL = "gpt-image-2";
const MAX_EDIT_IMAGES = 5;
const GENERATION_ENDPOINT = "images/generations";
const EDIT_ENDPOINT = "images/edits";
const GENERATED_IMAGES_DIRECTORY = "generated_images";

const IMAGE_GENERATION_DESCRIPTION = `Generate a new image from a description or edit existing images according to specific instructions.

Use this tool for requested diagrams, portraits, comics, memes, other visuals, and image edits. Generate directly without reconfirming unless required edit images are unavailable.

Omit both optional image selectors for a new image. For edits, use referenced_image_paths when every target image has an absolute local path. Use num_last_images_to_include only when at least one target image exists in recent conversation history without a local path, and request the smallest recent-image window containing every target. Never provide both selectors.`;

const imageGenerationParameters = Type.Object(
  {
    prompt: Type.String({
      description: "Complete image-generation or image-editing instructions.",
    }),
    referenced_image_paths: Type.Optional(
      Type.Array(
        Type.String({
          description: "Absolute path to a local image to include in an edit.",
        }),
        { maxItems: MAX_EDIT_IMAGES },
      ),
    ),
    num_last_images_to_include: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_EDIT_IMAGES,
        description: "Number of most recent conversation images to include in an edit.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type ImageGenerationDetails = {
  operation: "generate" | "edit";
  revisedPrompt: string;
  savedPath?: string;
  saveError?: string;
};

type JsonRequester = (
  model: Model<any>,
  path: string,
  body: JsonRecord,
  options: CodexJsonRequestOptions,
) => Promise<unknown>;

type ImageRequest = {
  operation: "generate" | "edit";
  endpoint: typeof GENERATION_ENDPOINT | typeof EDIT_ENDPOINT;
  body: JsonRecord;
};

function imageUrlsFromContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter(isObject)
    .toReversed()
    .filter((item) => item.type === "input_image" && typeof item["image_url"] === "string")
    .map((item) => item["image_url"] as string);
}

/** Return recent provider-history images in chronological order. */
export function recentImageUrls(history: readonly ResponsesItem[], count: number): string[] {
  const functionCallIds = new Set<string>();
  const customToolCallIds = new Set<string>();
  for (const item of history) {
    if (item.type === "function_call" && typeof item["call_id"] === "string") {
      functionCallIds.add(item["call_id"]);
    } else if (item.type === "custom_tool_call" && typeof item["call_id"] === "string") {
      customToolCallIds.add(item["call_id"]);
    }
  }

  const newestFirst: string[] = [];
  for (const item of history.toReversed()) {
    let imageUrls: string[] = [];
    if (item.type === undefined || item.type === "message") {
      imageUrls = imageUrlsFromContent(item.content);
    } else if (
      item.type === "function_call_output" &&
      typeof item["call_id"] === "string" &&
      functionCallIds.has(item["call_id"])
    ) {
      imageUrls = imageUrlsFromContent(item["output"]);
    } else if (
      item.type === "custom_tool_call_output" &&
      typeof item["call_id"] === "string" &&
      customToolCallIds.has(item["call_id"])
    ) {
      imageUrls = imageUrlsFromContent(item["output"]);
    } else if (item.type === "image_generation_call" && typeof item["result"] === "string") {
      imageUrls = [`data:image/png;base64,${item["result"]}`];
    }

    for (const imageUrl of imageUrls) {
      newestFirst.push(imageUrl);
      if (newestFirst.length === count) return newestFirst.reverse();
    }
  }
  return newestFirst.reverse();
}

function normalizeImagePath(path: string): string {
  const normalized = path.startsWith("@") ? path.slice(1) : path;
  if (!isAbsolute(normalized)) {
    throw new Error(`referenced image path must be absolute: ${path}`);
  }
  return normalized;
}

function imageMimeType(bytes: Uint8Array, path: string): string {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const signature = Buffer.from(bytes.subarray(0, 12)).toString("ascii");
  if (signature.startsWith("GIF87a") || signature.startsWith("GIF89a")) return "image/gif";
  if (signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP") return "image/webp";
  throw new Error(`unsupported referenced image format: ${path}`);
}

async function localImageUrl(path: string): Promise<string> {
  const absolutePath = normalizeImagePath(path);
  const bytes = await readFile(absolutePath);
  const mimeType = imageMimeType(bytes, absolutePath);
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

async function imageRequest(
  params: {
    prompt: string;
    referenced_image_paths?: string[];
    num_last_images_to_include?: number;
  },
  history: readonly ResponsesItem[],
): Promise<ImageRequest> {
  const paths = params.referenced_image_paths ?? [];
  const recentCount = params.num_last_images_to_include;
  if (paths.length > 0 && recentCount !== undefined) {
    throw new Error("provide only one of referenced_image_paths or num_last_images_to_include");
  }
  if (paths.length === 0 && recentCount === undefined) {
    return {
      operation: "generate",
      endpoint: GENERATION_ENDPOINT,
      body: {
        prompt: params.prompt,
        background: "auto",
        model: IMAGE_MODEL,
        quality: "auto",
        size: "auto",
      },
    };
  }

  const imageUrls =
    paths.length > 0
      ? await Promise.all(paths.map(localImageUrl))
      : recentImageUrls(history, recentCount ?? 0);
  const expectedCount = paths.length > 0 ? paths.length : recentCount;
  if (expectedCount === undefined || imageUrls.length !== expectedCount) {
    throw new Error(
      `requested ${expectedCount ?? 0} conversation images, but only ${imageUrls.length} were available`,
    );
  }
  return {
    operation: "edit",
    endpoint: EDIT_ENDPOINT,
    body: {
      images: imageUrls.map((imageUrl) => ({ image_url: imageUrl })),
      prompt: params.prompt,
      background: "auto",
      model: IMAGE_MODEL,
      quality: "auto",
      size: "auto",
    },
  };
}

function normalizedBase64(value: string): string {
  const normalized = value.replace(/\s+/g, "");
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw new Error("OpenAI Codex returned invalid generated-image data.");
  }
  return normalized;
}

function safePathSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/gu, "_");
  return sanitized || "generated_image";
}

async function saveGeneratedImage(
  sessionId: string,
  callId: string,
  imageBase64: string,
): Promise<string> {
  const directory = join(getAgentDir(), GENERATED_IMAGES_DIRECTORY, safePathSegment(sessionId));
  const outputPath = join(directory, `${safePathSegment(callId)}.png`);
  const imageBytes = Buffer.from(imageBase64, "base64");
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(outputPath, imageBytes, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(outputPath);
    if (!existing.equals(imageBytes)) throw error;
  }
  return outputPath;
}

function outputHint(outputPath: string): string {
  return `Generated images are saved to ${dirname(outputPath)} as ${outputPath} by default.
If you need to use the generated image at another path, copy it and leave the original in place unless the user explicitly asks you to delete it.
The generated image is already displayed to the user. There is no need to render it in the final response as a Markdown image or file link.`;
}

export default function registerImageGeneration(
  pi: ExtensionAPI,
  requestJson: JsonRequester = requestCodexJson,
): void {
  pi.registerTool({
    name: IMAGE_GENERATION_TOOL_NAME,
    label: IMAGE_GENERATION_TOOL_NAME,
    description: IMAGE_GENERATION_DESCRIPTION,
    parameters: imageGenerationParameters,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const model = ctx.model;
      if (!isCodexModel(model)) {
        throw new Error("image_gen.imagegen is available only with an OpenAI Codex model.");
      }
      onUpdate?.({
        content: [{ type: "text", text: "Generating image…" }],
        details: undefined,
      });
      const history = codexToolHistory(pi, ctx, model);
      const request = await imageRequest(params, history);
      const authentication = await codexToolAuthentication(ctx, model);
      const callId = toolCallId.split("|")[0] || toolCallId;
      const response = await requestJson(model, request.endpoint, request.body, {
        ...authentication,
        extraHeaders: { "x-codex-image-turn-id": callId },
        ...(signal ? { signal } : {}),
      });
      if (!isObject(response) || !Array.isArray(response["data"])) {
        throw new Error("OpenAI Codex returned an invalid image-generation response.");
      }
      const first = response["data"].find(isObject);
      if (!first || typeof first["b64_json"] !== "string") {
        throw new Error("OpenAI Codex image generation returned no image data.");
      }
      const imageBase64 = normalizedBase64(first["b64_json"]);
      let savedPath: string | undefined;
      let saveError: string | undefined;
      try {
        savedPath = await saveGeneratedImage(
          ctx.sessionManager.getSessionId(),
          callId,
          imageBase64,
        );
      } catch (error) {
        saveError = error instanceof Error ? error.message : String(error);
      }

      return {
        content: [
          { type: "image", data: imageBase64, mimeType: "image/png" },
          ...(savedPath ? [{ type: "text" as const, text: outputHint(savedPath) }] : []),
        ],
        details: {
          operation: request.operation,
          revisedPrompt: params.prompt,
          ...(savedPath ? { savedPath } : {}),
          ...(saveError ? { saveError } : {}),
        } satisfies ImageGenerationDetails,
      };
    },
  });
}
