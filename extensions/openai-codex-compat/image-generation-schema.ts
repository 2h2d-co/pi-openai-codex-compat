import { Type } from "typebox";

export const MAX_EDIT_IMAGES = 5;

export type ImageGenerationParameters = {
  prompt: string;
  referenced_image_paths?: string[] | null;
  num_last_images_to_include?: number | null;
};

const REFERENCED_IMAGE_PATH_DESCRIPTION =
  "Absolute path to a local PNG, JPEG, GIF, or WebP image to include in an edit. Convert relative paths to absolute paths before calling the tool; the file must exist and be readable.";

/**
 * Server-reserved image-generation schema. Range and selector constraints are
 * enforced by the executor because OpenAI rejects additional schema keywords.
 */
export const IMAGE_GENERATION_PARAMETERS = Type.Unsafe<ImageGenerationParameters>({
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
