import { isObject, type JsonRecord } from "../codex-protocol.ts";
import { CodexApiError } from "./codex-transport-errors.ts";

export function webSocketEventStartsVisibleOutput(event: JsonRecord): boolean {
  return (
    event.type !== "response.created" &&
    event.type !== "response.queued" &&
    event.type !== "response.in_progress" &&
    event.type !== "response.metadata"
  );
}

export async function decodeWebSocketData(data: unknown): Promise<string | undefined> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (isObject(data) && typeof data["arrayBuffer"] === "function") {
    const arrayBuffer = await (data["arrayBuffer"] as () => Promise<ArrayBuffer>)();
    return new TextDecoder().decode(new Uint8Array(arrayBuffer));
  }
  return undefined;
}

export function normalizeEvent(event: JsonRecord): JsonRecord | undefined {
  const type = typeof event.type === "string" ? event.type : undefined;
  if (!type) return undefined;
  if (type === "error") {
    const nested = isObject(event["error"]) ? event["error"] : undefined;
    const code =
      typeof event["code"] === "string"
        ? event["code"]
        : typeof nested?.["code"] === "string"
          ? nested["code"]
          : undefined;
    const message =
      typeof event["message"] === "string"
        ? event["message"]
        : typeof nested?.["message"] === "string"
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
