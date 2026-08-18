/** Runtime predicates shared by boundary validators and domain type guards. */
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

export function isFunction(value: unknown): value is CallableFunction {
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

export function isAllowedString<Value extends string>(
  value: unknown,
  allowed: ReadonlySet<Value>,
): value is Value {
  return isString(value) && [...allowed].some((candidate) => candidate === value);
}
