import { Type } from "typebox";

export const MAX_EDIT_IMAGES = 5;

export type ImageGenerationParameters = {
  prompt: string;
  referenced_image_paths?: string[] | null;
  num_last_images_to_include?: number | null;
};

const REFERENCED_IMAGE_PATH_DESCRIPTION =
  "Absolute local filesystem path, optionally prefixed with `@`, to a PNG, JPEG, GIF, or WebP image to include in an edit. Resolve relative paths against Pi's current working directory before calling the tool. Pi lexically normalizes `.` and `..` segments before reading the file, which must exist and be readable.";

/**
 * Exact server-reserved field structure. OpenAI rejects additional structural
 * constraints on this declaration, so provider serialization uses this schema.
 */
export const IMAGE_GENERATION_WIRE_PARAMETERS = Type.Unsafe<ImageGenerationParameters>({
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
        description: REFERENCED_IMAGE_PATH_DESCRIPTION,
      },
    },
  },
  required: ["prompt"],
  additionalProperties: false,
});

/**
 * Pi-facing schema. Pi validates these constraints before execution while the
 * executor retains equivalent checks as defense in depth.
 */
export const IMAGE_GENERATION_PARAMETERS = Type.Unsafe<ImageGenerationParameters>({
  type: "object",
  properties: {
    num_last_images_to_include: {
      type: ["integer", "null"],
      minimum: 1,
      maximum: MAX_EDIT_IMAGES,
    },
    prompt: {
      type: "string",
    },
    referenced_image_paths: {
      type: ["array", "null"],
      maxItems: MAX_EDIT_IMAGES,
      items: {
        type: "string",
        description: REFERENCED_IMAGE_PATH_DESCRIPTION,
      },
    },
  },
  required: ["prompt"],
  additionalProperties: false,
  not: {
    properties: {
      num_last_images_to_include: {
        type: "integer",
      },
      referenced_image_paths: {
        type: "array",
        minItems: 1,
      },
    },
    required: ["num_last_images_to_include", "referenced_image_paths"],
  },
});
