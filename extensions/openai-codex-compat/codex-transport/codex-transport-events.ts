import { isFunction, isNonNullObject, isString } from "../value-contracts.ts";
import { isObject, type JsonRecord } from "../codex-protocol.ts";
import { CodexApiError } from "./codex-transport-errors.ts";

interface ArrayBufferProvider {
  arrayBuffer: () => Promise<ArrayBuffer>;
}

function hasArrayBuffer(value: unknown): value is ArrayBufferProvider {
  return isNonNullObject(value) && "arrayBuffer" in value && isFunction(value.arrayBuffer);
}

export function webSocketEventStartsVisibleOutput(event: JsonRecord): boolean {
  return (
    event.type !== "response.created" &&
    event.type !== "response.queued" &&
    event.type !== "response.in_progress" &&
    event.type !== "response.metadata"
  );
}

export async function decodeWebSocketData(data: unknown): Promise<string | undefined> {
  if (isString(data)) return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (hasArrayBuffer(data)) {
    const arrayBuffer = await data.arrayBuffer();
    return new TextDecoder().decode(new Uint8Array(arrayBuffer));
  }
  return undefined;
}

export function normalizeEvent(event: JsonRecord): JsonRecord | undefined {
  const type = isString(event.type) ? event.type : undefined;
  if (!type) return undefined;
  if (type === "error") {
    const nested = isObject(event["error"]) ? event["error"] : undefined;
    const code = isString(event["code"])
      ? event["code"]
      : isString(nested?.["code"])
        ? nested["code"]
        : undefined;
    const message = isString(event["message"])
      ? event["message"]
      : isString(nested?.["message"])
        ? nested["message"]
        : undefined;
    throw new CodexApiError(
      `Codex error: ${message || code || JSON.stringify(event)}`,
      code,
      event,
    );
  }
  if (type === "response.done") {
    return { ...event, type: "response.completed" };
  }
  return event;
}

export function isTerminalEvent(event: JsonRecord): boolean {
  return (
    event.type === "response.completed" ||
    event.type === "response.incomplete" ||
    event.type === "response.failed"
  );
}
