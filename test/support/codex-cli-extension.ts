import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  requireJsonRecord,
  requireJsonRecords,
} from "../../extensions/openai-codex-compat/codex-protocol.ts";

type Marker = "FIRST" | "SECOND";

/**
 * The markers the model sees, in prompt order: the leading prompt travels as
 * `instructions` (or as the Lite developer prefix) and each later prompt
 * change is an inline developer update. `leading` is the first mention and
 * `current` the newest one.
 */
function promptMarkers(payload: Record<string, unknown>): { leading: Marker; current: Marker } {
  const input = requireJsonRecords(payload["input"]);
  const promptTexts = [
    typeof payload["instructions"] === "string" ? payload["instructions"] : "",
    ...input
      .filter(
        (item) =>
          (item["type"] === undefined || item["type"] === "message") &&
          item["role"] === "developer",
      )
      .map((item) => JSON.stringify(item["content"])),
  ];
  const markers = promptTexts.flatMap((text) => text.match(/FIRST|SECOND/g) ?? []);
  const asMarker = (value: string | undefined): Marker => (value === "SECOND" ? "SECOND" : "FIRST");
  assert.ok(markers.length > 0, "The request carries a system marker.");
  return { leading: asMarker(markers[0]), current: asMarker(markers.at(-1)) };
}

export default function (pi: ExtensionAPI): void {
  if (process.env["PI_CODEX_CLI_MOCK"] === "1") {
    let count = 0;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: function () {
        throw new Error("The SSE CLI fixture must not open a WebSocket");
      },
    });
    globalThis.fetch = async (_url, init) => {
      const bytes = init?.body;
      const text =
        typeof bytes === "string"
          ? bytes
          : bytes instanceof Uint8Array
            ? zstdDecompressSync(bytes).toString()
            : "";
      const request = requireJsonRecord(JSON.parse(text));
      const input = requireJsonRecords(request["input"]);
      const compact = input.some((item) => item["type"] === "compaction_trigger");
      const value = /user value: ([a-z]+)/.exec(
        JSON.stringify(input.filter((item) => item["role"] === "user").at(-1)),
      )?.[1];
      const marker = promptMarkers(request).current;
      count += 1;
      const item = compact
        ? { type: "compaction", id: `cmp_${count}`, encrypted_content: "mock-checkpoint" }
        : {
            type: "function_call",
            id: `fc_${count}`,
            call_id: `call_${count}`,
            name: "verify_release",
            arguments: JSON.stringify({ marker, value }),
            status: "completed",
          };
      const events = [
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: `resp_${count}`,
            status: "completed",
            usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
          },
        },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    };
  }

  pi.registerTool({
    name: "verify_release",
    label: "Verify Release",
    description: "Report the current system marker and the user's value.",
    parameters: Type.Object({ marker: Type.String(), value: Type.String() }),
    async execute(_id, args) {
      return { content: [{ type: "text", text: "accepted" }], details: args, terminate: true };
    },
  });
  pi.registerCommand("release-test-reload", {
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });
  pi.registerCommand("release-test-tools", {
    handler: async (args) => {
      pi.setActiveTools(args.split(","));
    },
  });
  // Record each request after its turn: appending a session entry between the
  // context event and the provider stream would move the leaf that percentage
  // compaction verifies.
  const observations: Record<string, unknown>[] = [];
  pi.on("before_provider_request", (event) => {
    const payload = requireJsonRecord(event.payload);
    const input = requireJsonRecords(payload["input"]);
    const markers = promptMarkers(payload);
    observations.push({
      reasoningMode: requireJsonRecord(payload["reasoning"])["mode"] ?? null,
      marker: markers.current,
      leadingMarker: markers.leading,
      checkpoint: input.some((item) => item["type"] === "compaction"),
      tools: requireJsonRecords(payload["tools"] ?? []).map((tool) => tool["name"]),
      inlineTools: input
        .filter((item) => item["type"] === "additional_tools")
        .flatMap((item) => requireJsonRecords(item["tools"]).map((tool) => tool["name"])),
    });
  });
  pi.on("turn_end", () => {
    for (const observation of observations.splice(0)) {
      pi.appendEntry("release-test-request", observation);
    }
  });
}
