/** Runtime predicates shared by boundary validators and domain type guards. */
export type UnknownFunction = (...args: never[]) => unknown;

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function requireString(value: unknown, description: string): string {
  if (!isString(value)) throw new Error(`${description} must be a string.`);
  return value;
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isFunction(value: unknown): value is UnknownFunction {
  return typeof value === "function";
}

/** Preserve JavaScript's `typeof value === "object"` semantics, including `null`. */
export function hasObjectType(value: unknown): value is object | null {
  return typeof value === "object";
}

export function isNonNullObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

export function nodeErrorCode(value: unknown): string | undefined {
  if (!(value instanceof Error) || !("code" in value)) return undefined;
  return isString(value.code) ? value.code : undefined;
}
