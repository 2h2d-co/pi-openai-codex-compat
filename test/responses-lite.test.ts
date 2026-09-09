import {
  requireJsonRecord,
  requireJsonRecords,
} from "../extensions/openai-codex-compat/codex-protocol.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyResponsesLite,
  applyResponsesLiteHeaders,
  RESPONSES_LITE_HEADER,
  RESPONSES_LITE_WS_METADATA_KEY,
  responsesLiteSsePayload,
  usesResponsesLite,
} from "../extensions/openai-codex-compat/responses-lite.ts";

test("selects only supported Responses Lite models when enabled", () => {
  assert.equal(usesResponsesLite("gpt-5.6-sol"), true);
  assert.equal(usesResponsesLite("gpt-5.6-terra"), true);
  assert.equal(usesResponsesLite("gpt-5.6-luna"), true);
  assert.equal(usesResponsesLite("gpt-6-astra"), true);
  assert.equal(usesResponsesLite("gpt-6-astra-preview"), false);
  assert.equal(usesResponsesLite("gpt-6"), false);
  assert.equal(usesResponsesLite("gpt-6-astra", false), false);
  assert.equal(usesResponsesLite("gpt-5.5"), false);
  assert.equal(usesResponsesLite("gpt-5.6-sol", false), false);
});

for (const modelId of ["gpt-5.6-sol", "gpt-6-astra"]) {
  test(`builds the Responses Lite instruction and tool prefix for ${modelId}`, () => {
    const payload = applyResponsesLite(
      {
        model: modelId,
        instructions: "Stable instructions",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_image", image_url: "data:image/png;base64,eA==", detail: "auto" },
            ],
          },
          {
            type: "function_call",
            call_id: "call-1",
            name: "read",
            arguments: "{}",
          },
        ],
        tools: [
          { type: "tool_search", execution: "client", description: "Search", parameters: {} },
          { type: "function", name: "read", description: "Read", parameters: {}, strict: false },
          {
            type: "namespace",
            name: "web",
            description: "Tools in the web namespace.",
            tools: [{ type: "function", name: "run", description: "Search", parameters: {} }],
          },
          {
            type: "custom",
            name: "apply_patch",
            description: "Patch",
            format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
          },
          { type: "web_search_preview" },
        ],
        parallel_tool_calls: true,
        reasoning: { effort: "low", summary: "auto" },
        client_metadata: { retained: "value" },
      },
      modelId,
    );

    assert.equal(payload.instructions, undefined);
    assert.equal(payload.tools, undefined);
    assert.equal(payload.parallel_tool_calls, false);
    assert.deepEqual(payload["reasoning"], {
      effort: "low",
      summary: "auto",
      context: "all_turns",
    });
    assert.deepEqual(payload.client_metadata, {
      retained: "value",
      [RESPONSES_LITE_WS_METADATA_KEY]: "true",
    });

    const input = requireJsonRecords(payload.input);
    assert.deepEqual(input.slice(0, 2), [
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          { type: "tool_search", execution: "client", description: "Search", parameters: {} },
          {
            type: "namespace",
            name: "functions",
            description: "",
            tools: [
              {
                type: "function",
                name: "read",
                description: "Read",
                parameters: {},
                strict: false,
              },
              {
                type: "custom",
                name: "apply_patch",
                description: "Patch",
                format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
              },
            ],
          },
          {
            type: "namespace",
            name: "web",
            description: "Tools in the web namespace.",
            tools: [{ type: "function", name: "run", description: "Search", parameters: {} }],
          },
        ],
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Stable instructions" }],
      },
    ]);
    assert.deepEqual(input[2], {
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,eA==" }],
    });
    assert.deepEqual(input[3], {
      type: "function_call",
      call_id: "call-1",
      name: "read",
      arguments: "{}",
    });

    const headers = new Headers();
    applyResponsesLiteHeaders(headers, payload);
    assert.equal(headers.get(RESPONSES_LITE_HEADER), "true");

    const ssePayload = responsesLiteSsePayload(payload);
    assert.equal(
      requireJsonRecord(ssePayload.client_metadata)[RESPONSES_LITE_WS_METADATA_KEY],
      undefined,
    );
    assert.equal(requireJsonRecord(ssePayload.client_metadata)["retained"], "value");
    assert.equal(
      requireJsonRecord(payload.client_metadata)[RESPONSES_LITE_WS_METADATA_KEY],
      "true",
    );
  });
}

test("matches upstream default-namespace grouping and ordering", () => {
  const payload = applyResponsesLite(
    {
      input: [],
      tools: [
        { type: "tool_search", execution: "client", description: "Search", parameters: {} },
        { type: "function", name: "lookup_order", description: "Lookup", parameters: {} },
        {
          type: "namespace",
          name: "editor",
          description: "Editing tools",
          tools: [{ type: "function", name: "edit", description: "Edit", parameters: {} }],
        },
        {
          type: "custom",
          name: "exec",
          description: "Run code",
          format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
        },
        {
          type: "namespace",
          name: "functions",
          description: "Existing default tools",
          tools: [{ type: "function", name: "existing", description: "Existing", parameters: {} }],
        },
        { type: "function", name: "last", description: "Last", parameters: {} },
      ],
    },
    "gpt-5.6-sol",
  );

  const additionalTools = requireJsonRecords(payload.input)[0];
  assert.ok(additionalTools);
  assert.deepEqual(additionalTools["tools"], [
    { type: "tool_search", execution: "client", description: "Search", parameters: {} },
    {
      type: "namespace",
      name: "functions",
      description: "Existing default tools",
      tools: [
        { type: "function", name: "lookup_order", description: "Lookup", parameters: {} },
        {
          type: "custom",
          name: "exec",
          description: "Run code",
          format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
        },
        { type: "function", name: "existing", description: "Existing", parameters: {} },
        { type: "function", name: "last", description: "Last", parameters: {} },
      ],
    },
    {
      type: "namespace",
      name: "editor",
      description: "Editing tools",
      tools: [{ type: "function", name: "edit", description: "Edit", parameters: {} }],
    },
  ]);
});

test("omits an empty default namespace and rejects invalid members", () => {
  const payload = applyResponsesLite(
    {
      input: [],
      tools: [
        {
          type: "namespace",
          name: "functions",
          description: "Empty default tools",
          tools: [],
        },
      ],
    },
    "gpt-5.6-sol",
  );
  assert.deepEqual(requireJsonRecords(payload.input)[0]?.["tools"], []);

  assert.throws(
    () =>
      applyResponsesLite(
        {
          input: [],
          tools: [
            {
              type: "namespace",
              name: "functions",
              description: "",
              tools: [{ type: "web_search", name: "invalid" }],
            },
          ],
        },
        "gpt-5.6-sol",
      ),
    /invalid functions namespace tool/,
  );
  assert.throws(
    () =>
      applyResponsesLite(
        {
          input: [],
          tools: [{ type: "function", description: "Missing name", parameters: {} }],
        },
        "gpt-5.6-sol",
      ),
    /invalid default-namespace tool/,
  );
});

test("leaves ordinary Responses requests unchanged", () => {
  const payload = { input: [], instructions: "ordinary" };
  assert.equal(applyResponsesLite(payload, "gpt-5.5"), payload);
  assert.equal(applyResponsesLite(payload, "gpt-5.6-sol", false), payload);
  assert.equal(applyResponsesLite(payload, "gpt-6-astra", false), payload);
  assert.throws(() => applyResponsesLite({}, "gpt-6-astra"), /requires array input/);
});
