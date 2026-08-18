import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import {
  isFunction,
  isNonNullObject,
} from "../../extensions/openai-codex-compat/value-contracts.ts";

export function partialFixture<T extends object, Members extends object = object>(
  members: Members,
): T {
  // oxlint-disable-next-line typescript/no-unsafe-return -- Focused test doubles intentionally implement only the members exercised by each test.
  return Object.assign(Object.create(null), members);
}

/**
 * Adapt a focused test double to Pi's broad extension API. Unimplemented
 * members remain absent and fail immediately if production code reaches them.
 */
export function extensionApiFixture<Members extends object>(members: Members): ExtensionAPI {
  return partialFixture(members);
}

export function extensionContextFixture<Members extends object>(
  members: Members,
): ExtensionContext {
  return partialFixture(members);
}

export function extensionCommandContextFixture<Members extends object>(
  members: Members,
): ExtensionCommandContext {
  return partialFixture(members);
}

export function tuiFixture<Members extends object>(members: Members): TUI {
  return partialFixture(members);
}

export function themeFixture<Members extends object>(members: Members): Theme {
  return partialFixture(members);
}

export interface BuiltinModelsModule {
  getBuiltinModels?(provider: string): Model<"openai-codex-responses">[];
}

export function requireBuiltinModelsModule(value: unknown): BuiltinModelsModule {
  if (!isNonNullObject(value)) throw new Error("Pi AI module must be an object.");
  if (
    "getBuiltinModels" in value &&
    value.getBuiltinModels !== undefined &&
    !isFunction(value.getBuiltinModels)
  ) {
    throw new Error("Pi AI getBuiltinModels export must be a function.");
  }
  return value;
}

export function responseFixture<Members extends object>(members: Members): Response {
  return partialFixture(members);
}

export function assistantMessageEventStreamFixture<Members extends object>(
  members: Members,
): AssistantMessageEventStream {
  return partialFixture(members);
}
