import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  requireJsonRecord,
  requireJsonRecords,
} from "../../extensions/openai-codex-compat/codex-protocol.ts";

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
      const instructions =
        typeof request["instructions"] === "string"
          ? request["instructions"]
          : JSON.stringify(input.filter((item) => item["role"] === "developer"));
      const value = /user value: ([a-z]+)/.exec(
        JSON.stringify(input.filter((item) => item["role"] === "user").at(-1)),
      )?.[1];
      const marker = instructions.includes("SECOND") ? "SECOND" : "FIRST";
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
  pi.on("before_provider_request", (event) => {
    const payload = requireJsonRecord(event.payload);
    const input = requireJsonRecords(payload["input"]);
    const instructions =
      typeof payload["instructions"] === "string"
        ? payload["instructions"]
        : JSON.stringify(input.filter((item) => item["role"] === "developer"));
    assert.match(instructions, /FIRST|SECOND/);
    pi.appendEntry("release-test-request", {
      marker: instructions.includes("SECOND") ? "SECOND" : "FIRST",
      checkpoint: input.some((item) => item["type"] === "compaction"),
    });
  });
}
