import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  Model,
  TextContent,
  TextSignatureV1,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

/**
 * Focused copies of the methods used to serialize Pi messages for OpenAI's
 * Responses API. Adapted from @earendil-works/pi-ai@0.83.0:
 *
 * - src/api/openai-responses-shared.ts
 * - src/api/transform-messages.ts
 * - src/api/constrained-sampling.ts
 * - src/utils/hash.ts
 * - src/utils/sanitize-unicode.ts
 *
 * Keep this module behaviorally aligned with Pi AI when updating the peer
 * dependency. It is local because Pi's extension loader does not expose the
 * openai-responses-shared package subpath to extensions.
 */

export type ResponsesItem = Record<string, unknown>;
type ToolResultOutput =
  | string
  | Array<
      | { type: "input_text"; text: string }
      | { type: "input_image"; detail: "auto"; image_url: string }
    >;

type ConvertResponsesMessagesOptions = {
  includeSystemPrompt?: boolean;
  grammarToolInputProperties?: ReadonlyMap<string, string>;
  deferredTools?: ReadonlyMap<string, Tool>;
  toolOptions?: ConvertResponsesToolsOptions;
  nativeAssistantItems?: ReadonlyMap<string, readonly ResponsesItem[]>;
};

type ConvertResponsesToolsOptions = {
  strict?: boolean | null;
  supportsStrictMode?: boolean;
  supportsOpenAIGrammarTools?: boolean;
  deferLoading?: boolean;
};

type JsonSchemaObject = {
  type?: unknown;
  properties?: Record<string, JsonSchemaObject | undefined>;
  required?: unknown;
};

function shortHash(value: string): string {
  let high = 0xdeadbeef;
  let low = 0x41c6ce57;
  for (let index = 0; index < value.length; index++) {
    const character = value.charCodeAt(index);
    high = Math.imul(high ^ character, 2_654_435_761);
    low = Math.imul(low ^ character, 1_597_334_677);
  }
  high =
    Math.imul(high ^ (high >>> 16), 2_246_822_507) ^ Math.imul(low ^ (low >>> 13), 3_266_489_909);
  low =
    Math.imul(low ^ (low >>> 16), 2_246_822_507) ^ Math.imul(high ^ (high >>> 13), 3_266_489_909);
  return (low >>> 0).toString(36) + (high >>> 0).toString(36);
}

function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

function getGrammarToolInput(
  toolName: string,
  arguments_: Record<string, unknown>,
  inputProperty: string,
): string {
  const input = arguments_[inputProperty];
  if (typeof input !== "string") {
    throw new Error(
      `Grammar tool call "${toolName}" requires argument "${inputProperty}" to be a string.`,
    );
  }
  return input;
}

function inferGrammarInputProperty(tool: Tool): string {
  const schema = tool.parameters as JsonSchemaObject;
  if (schema.type !== "object") {
    throw new Error("grammar constrained sampling requires an object parameter schema");
  }
  if (
    !Array.isArray(schema.required) ||
    schema.required.length !== 1 ||
    typeof schema.required[0] !== "string"
  ) {
    throw new Error("grammar constrained sampling requires exactly one required string property");
  }

  const inputProperty = schema.required[0];
  if (!schema.properties?.[inputProperty]) {
    throw new Error(
      `grammar constrained sampling requires a properties entry for ${inputProperty}`,
    );
  }
  if (schema.properties[inputProperty]?.type !== "string") {
    throw new Error(`grammar constrained sampling property ${inputProperty} must have type string`);
  }
  return inputProperty;
}

function resolveJsonSchemaStrictSampling(
  tool: Tool,
  supportsStrictMode: boolean,
): boolean | undefined {
  const config = tool.constrainedSampling;
  if (!config || config.type !== "json_schema") return undefined;
  if (supportsStrictMode) return true;
  if (config.strict === "require") {
    throw new Error(
      `Tool "${tool.name}" requires JSON-schema constrained sampling, but strict tools are unsupported.`,
    );
  }
  return undefined;
}

function resolveGrammarConstrainedSampling(
  tool: Tool,
  supportsOpenAIGrammarTools: boolean,
): { format: "lark" | "regex"; definition: string; inputProperty: string } | undefined {
  const config = tool.constrainedSampling;
  if (!config || config.type !== "grammar" || !supportsOpenAIGrammarTools) return undefined;

  const larkDefinition = config.variants.openai_lark;
  const regexDefinition = config.variants.openai_regex;
  const hasLarkDefinition = typeof larkDefinition === "string" && larkDefinition.trim().length > 0;
  const hasRegexDefinition =
    typeof regexDefinition === "string" && regexDefinition.trim().length > 0;
  if (!hasLarkDefinition && !hasRegexDefinition) {
    throw new Error(
      `Tool "${tool.name}" cannot use grammar constrained sampling: no supported grammar variant was provided.`,
    );
  }

  try {
    return {
      format: hasLarkDefinition ? "lark" : "regex",
      definition: hasLarkDefinition ? larkDefinition : regexDefinition!,
      inputProperty: inferGrammarInputProperty(tool),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Tool "${tool.name}" cannot use grammar constrained sampling: ${message}.`);
  }
}

function convertResponsesTools(
  tools: readonly Tool[],
  options?: ConvertResponsesToolsOptions,
): ResponsesItem[] {
  const defaultStrict = options?.strict === undefined ? false : options.strict;
  const supportsStrictMode = options?.supportsStrictMode ?? true;
  const supportsOpenAIGrammarTools = options?.supportsOpenAIGrammarTools ?? false;

  return tools.map((tool) => {
    const grammar = resolveGrammarConstrainedSampling(tool, supportsOpenAIGrammarTools);
    if (grammar) {
      return {
        type: "custom",
        name: tool.name,
        description: tool.description,
        format: {
          type: "grammar",
          syntax: grammar.format,
          definition: grammar.definition,
        },
        ...(options?.deferLoading ? { defer_loading: true } : {}),
      };
    }

    const constrainedStrict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(options?.deferLoading ? { defer_loading: true } : {}),
      ...(supportsStrictMode ? { strict: constrainedStrict ?? defaultStrict } : {}),
    };
  });
}

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function replaceImagesWithPlaceholder(
  content: (TextContent | ImageContent)[],
  placeholder: string,
): TextContent[] {
  const result: TextContent[] = [];
  let previousWasPlaceholder = false;

  for (const block of content) {
    if (block.type === "image") {
      if (!previousWasPlaceholder) result.push({ type: "text", text: placeholder });
      previousWasPlaceholder = true;
      continue;
    }
    result.push(block);
    previousWasPlaceholder = block.text === placeholder;
  }
  return result;
}

function downgradeUnsupportedImages(messages: Message[], model: Model<any>): Message[] {
  if (model.input.includes("image")) return messages;
  return messages.map((message) => {
    if (message.role === "user" && Array.isArray(message.content)) {
      return {
        ...message,
        content: replaceImagesWithPlaceholder(message.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
      };
    }
    if (message.role === "toolResult") {
      return {
        ...message,
        content: replaceImagesWithPlaceholder(message.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
      };
    }
    return message;
  });
}

function transformMessages(
  messages: Message[],
  model: Model<any>,
  normalizeToolCallId?: (id: string, model: Model<any>, source: AssistantMessage) => string,
): Message[] {
  const toolCallIdMap = new Map<string, string>();
  const normalizedMessages = messages.map((message) =>
    message.content == null ? { ...message, content: [] } : message,
  );
  const imageAwareMessages = downgradeUnsupportedImages(normalizedMessages, model);

  const transformed = imageAwareMessages.map((message) => {
    if (message.role === "user") return message;
    if (message.role === "toolResult") {
      const normalizedId = toolCallIdMap.get(message.toolCallId);
      return normalizedId && normalizedId !== message.toolCallId
        ? { ...message, toolCallId: normalizedId }
        : message;
    }

    const assistantMessage = message as AssistantMessage;
    const isSameModel =
      assistantMessage.provider === model.provider &&
      assistantMessage.api === model.api &&
      assistantMessage.model === model.id;
    const transformedContent = assistantMessage.content.flatMap((block) => {
      if (block.type === "thinking") {
        if (block.redacted) return isSameModel ? block : [];
        if (isSameModel && block.thinkingSignature) return block;
        if (!block.thinking || block.thinking.trim() === "") return [];
        if (isSameModel) return block;
        return { type: "text" as const, text: block.thinking };
      }
      if (block.type === "text") {
        return isSameModel ? block : { type: "text" as const, text: block.text };
      }
      if (block.type === "toolCall") {
        const toolCall = block as ToolCall;
        let normalizedToolCall = toolCall;
        if (!isSameModel && toolCall.thoughtSignature) {
          normalizedToolCall = { ...toolCall };
          delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
        }
        if (!isSameModel && normalizeToolCallId) {
          const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMessage);
          if (normalizedId !== toolCall.id) {
            toolCallIdMap.set(toolCall.id, normalizedId);
            normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
          }
        }
        return normalizedToolCall;
      }
      return block;
    });
    return { ...assistantMessage, content: transformedContent };
  });

  const result: Message[] = [];
  let pendingToolCalls: ToolCall[] = [];
  let existingToolResultIds = new Set<string>();
  const insertSyntheticToolResults = () => {
    for (const toolCall of pendingToolCalls) {
      if (existingToolResultIds.has(toolCall.id)) continue;
      result.push({
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "No result provided" }],
        isError: true,
        timestamp: Date.now(),
      } as ToolResultMessage);
    }
    pendingToolCalls = [];
    existingToolResultIds = new Set();
  };

  for (const message of transformed) {
    if (message.role === "assistant") {
      insertSyntheticToolResults();
      const assistantMessage = message as AssistantMessage;
      if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
        continue;
      }
      const toolCalls = assistantMessage.content.filter(
        (block): block is ToolCall => block.type === "toolCall",
      );
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
        existingToolResultIds = new Set();
      }
      result.push(message);
    } else if (message.role === "toolResult") {
      existingToolResultIds.add(message.toolCallId);
      result.push(message);
    } else if (message.role === "user") {
      insertSyntheticToolResults();
      result.push(message);
    } else {
      result.push(message);
    }
  }
  insertSyntheticToolResults();
  return result;
}

function parseTextSignature(
  signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
  if (!signature) return undefined;
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
      if (parsed.v === 1 && typeof parsed.id === "string") {
        if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
          return { id: parsed.id, phase: parsed.phase };
        }
        return { id: parsed.id };
      }
    } catch {
      // Fall through to legacy plain-string handling.
    }
  }
  return { id: signature };
}

function convertToolResultOutput(
  model: Model<any>,
  content: readonly (TextContent | ImageContent)[],
): ToolResultOutput {
  const textResult = content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  const images = content.filter((item): item is ImageContent => item.type === "image");
  const hasText = textResult.length > 0;

  if (images.length === 0 || !model.input.includes("image")) {
    return sanitizeSurrogates(
      hasText ? textResult : images.length > 0 ? "(see attached image)" : "(no tool output)",
    );
  }

  return [
    ...(hasText ? [{ type: "input_text" as const, text: sanitizeSurrogates(textResult) }] : []),
    ...images.map((image) => ({
      type: "input_image" as const,
      detail: "auto" as const,
      image_url: `data:${image.mimeType};base64,${image.data}`,
    })),
  ];
}

export function convertResponsesMessages(
  model: Model<any>,
  context: Context,
  allowedToolCallProviders: ReadonlySet<string>,
  options?: ConvertResponsesMessagesOptions,
): ResponsesItem[] {
  const messages: ResponsesItem[] = [];
  const loadedToolNames = new Set<string>();
  const normalizeIdPart = (part: string): string => {
    const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
    const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
    return normalized.replace(/_+$/, "");
  };
  const buildForeignResponsesItemId = (itemId: string): string => {
    const normalized = `fc_${shortHash(itemId)}`;
    return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
  };
  const normalizeToolCallId = (
    id: string,
    _targetModel: Model<any>,
    source: AssistantMessage,
  ): string => {
    if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
    if (!id.includes("|")) return normalizeIdPart(id);
    const [callId, itemId] = id.split("|");
    const normalizedCallId = normalizeIdPart(callId!);
    const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
    let normalizedItemId = isForeignToolCall
      ? buildForeignResponsesItemId(itemId!)
      : normalizeIdPart(itemId!);
    if (!normalizedItemId.startsWith("fc_")) {
      normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
    }
    return `${normalizedCallId}|${normalizedItemId}`;
  };

  const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
  const includeSystemPrompt = options?.includeSystemPrompt ?? true;
  if (includeSystemPrompt && context.systemPrompt) {
    const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
    messages.push({
      role: model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system",
      content: sanitizeSurrogates(context.systemPrompt),
    });
  }

  let messageIndex = 0;
  for (const message of transformedMessages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        messages.push({
          role: "user",
          content: [{ type: "input_text", text: sanitizeSurrogates(message.content) }],
        });
      } else {
        const content = message.content.map((item) =>
          item.type === "text"
            ? { type: "input_text", text: sanitizeSurrogates(item.text) }
            : {
                type: "input_image",
                detail: "auto",
                image_url: `data:${item.mimeType};base64,${item.data}`,
              },
        );
        if (content.length === 0) continue;
        messages.push({ role: "user", content });
      }
    } else if (message.role === "assistant") {
      const nativeItems = message.responseId
        ? options?.nativeAssistantItems?.get(message.responseId)
        : undefined;
      if (nativeItems) {
        messages.push(...nativeItems.map((item) => structuredClone(item)));
        messageIndex++;
        continue;
      }

      const output: ResponsesItem[] = [];
      const assistantMessage = message as AssistantMessage;
      const isDifferentModel =
        assistantMessage.model !== model.id &&
        assistantMessage.provider === model.provider &&
        assistantMessage.api === model.api;
      let textBlockIndex = 0;

      for (const block of message.content) {
        if (block.type === "thinking") {
          if (block.thinkingSignature) {
            output.push(JSON.parse(block.thinkingSignature) as ResponsesItem);
          }
        } else if (block.type === "text") {
          const parsedSignature = parseTextSignature(block.textSignature);
          const fallbackMessageId =
            textBlockIndex === 0
              ? `msg_pi_${messageIndex}`
              : `msg_pi_${messageIndex}_${textBlockIndex}`;
          textBlockIndex++;
          let messageId = parsedSignature?.id ?? fallbackMessageId;
          if (messageId.length > 64) messageId = `msg_${shortHash(messageId)}`;
          output.push({
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] },
            ],
            status: "completed",
            id: messageId,
            phase: parsedSignature?.phase,
          });
        } else if (block.type === "toolCall") {
          const [callId, itemIdRaw] = block.id.split("|");
          const customInputProperty = options?.grammarToolInputProperties?.get(block.name);
          let itemId = itemIdRaw;
          if (
            (isDifferentModel && itemId?.startsWith("fc_")) ||
            (customInputProperty === undefined && !itemId?.startsWith("fc_"))
          ) {
            itemId = undefined;
          }
          if (customInputProperty !== undefined) {
            output.push({
              type: "custom_tool_call",
              id: itemId,
              call_id: callId,
              name: block.name,
              input: sanitizeSurrogates(
                getGrammarToolInput(block.name, block.arguments, customInputProperty),
              ),
            });
          } else {
            output.push({
              type: "function_call",
              id: itemId,
              call_id: callId,
              name: block.name,
              arguments: JSON.stringify(block.arguments),
            });
          }
        }
      }
      if (output.length === 0) continue;
      messages.push(...output);
    } else if (message.role === "toolResult") {
      const [callId] = message.toolCallId.split("|");
      const output = convertToolResultOutput(model, message.content);
      messages.push({
        type: options?.grammarToolInputProperties?.has(message.toolName)
          ? "custom_tool_call_output"
          : "function_call_output",
        call_id: callId,
        output,
      });

      const deferredTools: Tool[] = [];
      for (const name of message.addedToolNames ?? []) {
        const tool = options?.deferredTools?.get(name);
        if (!tool || loadedToolNames.has(name)) continue;
        loadedToolNames.add(name);
        deferredTools.push(tool);
      }
      if (deferredTools.length > 0) {
        const names = deferredTools.map((tool) => tool.name);
        const searchCallId = `pi_tool_load_${shortHash(
          `${message.toolCallId}:${names.join(",")}`,
        )}`;
        messages.push({
          type: "tool_search_call",
          call_id: searchCallId,
          execution: "client",
          status: "completed",
          arguments: { query: names.join(" "), limit: names.length },
        });
        messages.push({
          type: "tool_search_output",
          call_id: searchCallId,
          execution: "client",
          status: "completed",
          tools: convertResponsesTools(deferredTools, {
            ...options?.toolOptions,
            deferLoading: true,
          }),
        });
      }
    }
    messageIndex++;
  }
  return messages;
}
