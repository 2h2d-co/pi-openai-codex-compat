export function errorFromThrown(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value });
}
