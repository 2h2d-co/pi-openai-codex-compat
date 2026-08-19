import type { Model } from "@earendil-works/pi-ai";
import {
  isFunction,
  isNonNullObject,
} from "../../extensions/openai-codex-compat/value-contracts.ts";

export interface BuiltinModelsModule {
  getBuiltinModels?: (provider: string) => Model<"openai-codex-responses">[];
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
