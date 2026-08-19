import { isString, nodeErrorCode } from "./value-contracts.ts";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { errorFromThrown } from "./error-from-thrown.ts";
import type { ConfigResolver } from "./config-context.ts";
import type { CodexToolBackgroundResolver } from "./codex-tool-surface.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { isObject, type JsonRecord, type JsonValue, type ResponsesItem } from "./codex-protocol.ts";
import { requestCodexJson, type CodexJsonRequestOptions } from "./codex-transport.ts";
import {
  IMAGE_GENERATION_PARAMETERS,
  MAX_EDIT_IMAGES,
  type ImageGenerationParameters,
} from "./image-generation-schema.ts";
import { IMAGE_GENERATION_TOOL_NAME } from "./namespaced-tools.ts";
import {
  renderImageGenerationCall,
  renderImageGenerationResult,
  type ImageGenerationDetails,
} from "./image-generation-render.ts";
import { isCodexModel } from "./request-options.ts";
import type {
  CodexToolExecutionContext,
  ToolDefinitionWithContext,
} from "./tool-definition-contract.ts";
import { codexToolAuthentication, codexToolHistory } from "./tool-runtime.ts";

const IMAGE_MODEL = "gpt-image-2";
const GENERATION_ENDPOINT = "images/generations";

export type ImageGenerationTool = ToolDefinitionWithContext<
  typeof IMAGE_GENERATION_PARAMETERS,
  ImageGenerationDetails,
  Record<string, never>,
  CodexToolExecutionContext
>;
export type ImageGenerationApi = Pick<ExtensionAPI, "getAllTools"> & {
  registerTool: (tool: ImageGenerationTool) => void;
};
const EDIT_ENDPOINT = "images/edits";
const GENERATED_IMAGES_DIRECTORY = "generated_images";

const IMAGE_GENERATION_DESCRIPTION = `The \`image_gen.imagegen\` tool generates new images from descriptions and edits existing images according to specific instructions. Use it when:

- The user requests an image based on a scene description, such as a diagram, portrait, comic, meme, or any other visual.
- The user wants to modify a local, attached, or previously generated image by adding or removing elements, changing colors, improving quality or resolution, or transforming its style.

Guidelines:
- Call \`image_gen.imagegen\` directly without reconfirmation unless required source images are unavailable.
- Omit both \`referenced_image_paths\` and \`num_last_images_to_include\` when generating a brand new image.
- For edits, use \`referenced_image_paths\` when every target image has an absolute local path, with at most 5 paths. Use \`read\` first when you need to inspect a local image.
- Use \`num_last_images_to_include\` only when at least one target image has no local path, and set it to the smallest number of recent conversation images that includes every target, up to 5.
- Never provide both \`referenced_image_paths\` and \`num_last_images_to_include\`.
- If neither mechanism can include every target image, ask the user to attach the missing images again.
- Generated images are returned, displayed, and saved automatically. Do not embed the image in the final response unless the user asks.
`;

export type { ImageGenerationDetails } from "./image-generation-render.ts";

type JsonRequester = (
  model: Model<Api>,
  path: string,
  body: JsonRecord,
  options: CodexJsonRequestOptions,
) => Promise<JsonValue>;
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
    .filter((item) => item.type === "input_image" && isString(item["image_url"]))
    .flatMap((item) => (isString(item["image_url"]) ? [item["image_url"]] : []));
}

/** Return recent provider-history images in chronological order. */
export function recentImageUrls(history: readonly ResponsesItem[], count: number): string[] {
  const functionCallIds = new Set<string>();
  const customToolCallIds = new Set<string>();
  for (const item of history) {
    if (item.type === "function_call" && isString(item["call_id"])) {
      functionCallIds.add(item["call_id"]);
    } else if (item.type === "custom_tool_call" && isString(item["call_id"])) {
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
      isString(item["call_id"]) &&
      functionCallIds.has(item["call_id"])
    ) {
      imageUrls = imageUrlsFromContent(item["output"]);
    } else if (
      item.type === "custom_tool_call_output" &&
      isString(item["call_id"]) &&
      customToolCallIds.has(item["call_id"])
    ) {
      imageUrls = imageUrlsFromContent(item["output"]);
    } else if (item.type === "image_generation_call" && isString(item["result"])) {
      imageUrls = [`data:image/png;base64,${item["result"]}`];
    }

    for (const imageUrl of imageUrls) {
      newestFirst.push(imageUrl);
      if (newestFirst.length === count) return newestFirst.reverse();
    }
  }
  return newestFirst.reverse();
}

export function normalizeImagePath(path: string): string {
  const unprefixed = path.startsWith("@") ? path.slice(1) : path;
  if (!isAbsolute(unprefixed)) {
    throw new Error(`referenced image path must be absolute: ${path}`);
  }
  return normalize(unprefixed);
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
  params: ImageGenerationParameters,
  history: readonly ResponsesItem[],
): Promise<ImageRequest> {
  const paths = params.referenced_image_paths ?? [];
  const recentCount = params.num_last_images_to_include ?? undefined;
  if (paths.length > MAX_EDIT_IMAGES) {
    throw new Error(`referenced_image_paths must contain at most ${MAX_EDIT_IMAGES} paths`);
  }
  if (
    recentCount !== undefined &&
    (!Number.isInteger(recentCount) || recentCount < 1 || recentCount > MAX_EDIT_IMAGES)
  ) {
    throw new Error(`num_last_images_to_include must be between 1 and ${MAX_EDIT_IMAGES}`);
  }
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
    if (nodeErrorCode(error) !== "EEXIST") throw error;
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
  pi: ImageGenerationApi,
  resolveConfig: ConfigResolver,
  resolveToolBackground: CodexToolBackgroundResolver = () => DEFAULT_CONFIG.toolBackground,
  requestJson: JsonRequester = requestCodexJson,
): void {
  pi.registerTool({
    name: IMAGE_GENERATION_TOOL_NAME,
    label: IMAGE_GENERATION_TOOL_NAME,
    description: IMAGE_GENERATION_DESCRIPTION,
    promptSnippet: "Generate new images or edit existing images",
    promptGuidelines: [
      "Use image_gen.imagegen directly to generate new images or edit existing images without reconfirmation unless required source images are unavailable.",
      "For new images, call image_gen.imagegen without referenced_image_paths or num_last_images_to_include.",
      "For image_gen.imagegen edits, use up to five absolute referenced_image_paths when every target is local; otherwise use num_last_images_to_include from 1 to 5, and use read when you need to inspect a local image.",
      "Never pass both image selectors to image_gen.imagegen; ask the user to reattach images when every target cannot be referenced.",
    ],
    parameters: IMAGE_GENERATION_PARAMETERS,
    executionMode: "sequential",
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const model = ctx.model;
      if (!isCodexModel(model)) {
        throw new Error("image_gen.imagegen is available only with an OpenAI Codex model.");
      }
      onUpdate?.({
        content: [{ type: "text", text: "Generating image…" }],
        details: {
          operation:
            (params.referenced_image_paths?.length ?? 0) > 0 ||
            (params.num_last_images_to_include !== undefined &&
              params.num_last_images_to_include !== null)
              ? "edit"
              : "generate",
          revisedPrompt: params.prompt,
        },
      });
      const config = resolveConfig(ctx);
      const history = codexToolHistory(pi, ctx, model, config.imageDetail);
      const request = await imageRequest(params, history);
      const authentication = await codexToolAuthentication(ctx, model);
      const callId = toolCallId.split("|")[0] || toolCallId;
      const requestOptions: CodexJsonRequestOptions = {
        ...authentication,
        extraHeaders: { "x-codex-image-turn-id": callId },
      };
      if (signal) requestOptions.signal = signal;
      const response = await requestJson(model, request.endpoint, request.body, requestOptions);
      if (!isObject(response) || !Array.isArray(response["data"])) {
        throw new Error("OpenAI Codex returned an invalid image-generation response.");
      }
      const first = response["data"].find(isObject);
      if (!first || !isString(first["b64_json"])) {
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
      } catch (cause) {
        const error = errorFromThrown(
          cause,
          "Saving the generated image failed with a non-Error value.",
        );
        saveError = error.message;
      }

      const content: Array<
        { type: "image"; data: string; mimeType: "image/png" } | { type: "text"; text: string }
      > = [{ type: "image", data: imageBase64, mimeType: "image/png" }];
      if (savedPath) content.push({ type: "text", text: outputHint(savedPath) });
      const details: ImageGenerationDetails = {
        operation: request.operation,
        revisedPrompt: params.prompt,
      };
      if (savedPath) details.savedPath = savedPath;
      if (saveError) details.saveError = saveError;
      return { content, details };
    },
    renderCall(args, theme, context) {
      return renderImageGenerationCall(args, theme, context, resolveToolBackground);
    },
    renderResult(result, options, theme, context) {
      return renderImageGenerationResult(result, options, theme, context, resolveToolBackground);
    },
  });
}
