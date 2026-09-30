import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  getCurrentTools,
  getDeclaredTools,
  InMemoryCredentialStore,
  Type,
  type Message,
  type Tool,
} from "@earendil-works/pi-ai";
import {
  convertToLlm,
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ToolExposure,
} from "@earendil-works/pi-coding-agent";
import {
  CODEMODE_TOOL_NAME,
  codemodeHiddenTools,
  projectCodemodeTranscript,
} from "../extensions/openai-codex-compat/codemode-loadout.ts";

const EXPOSED_TOOLS: ReadonlyArray<{ name: string; exposure: ToolExposure }> = [
  { name: "direct_alpha", exposure: "direct" },
  { name: "direct_beta", exposure: "direct" },
  { name: "model_only", exposure: "model-only" },
  { name: "script_only", exposure: "codemode" },
  { name: "deferred_tool", exposure: "deferred" },
  { name: "hidden_tool", exposure: "hidden" },
];
const CANDIDATES = [CODEMODE_TOOL_NAME, ...EXPOSED_TOOLS.map((tool) => tool.name)];

function names(tools: readonly Tool[]): string[] {
  return tools.map((tool) => tool.name).toSorted();
}

function declarations(tools: readonly Tool[]): unknown {
  return JSON.parse(
    JSON.stringify(tools.toSorted((left, right) => left.name.localeCompare(right.name))),
  );
}

for (const mode of [undefined, "on", "only"] as const) {
  test(`mirrors Pi's codemode request tools for every loadout with codemode.mode=${mode ?? "unset"}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-codex-codemode-loadout-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const faux = fauxProvider();
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(root, "models-store.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      ...(mode === undefined ? {} : { codemode: { mode } }),
    });
    let api: ExtensionAPI | undefined;
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => "Synthetic loadout test.",
      extensionFactories: [
        createCodemodeExtension(),
        (pi) => {
          api = pi;
          pi.registerProvider(faux.provider);
          for (const { name, exposure } of EXPOSED_TOOLS) {
            pi.registerTool(
              defineTool({
                name,
                label: name,
                description: `The ${exposure} tool ${name}.`,
                parameters: Type.Object({ value: Type.String() }),
                exposure,
                async execute() {
                  return { content: [{ type: "text", text: "ok" }], details: {} };
                },
              }),
            );
          }
        },
      ],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: root,
      modelRuntime,
      settingsManager,
      sessionManager: SessionManager.inMemory(root),
      resourceLoader,
      model: faux.getModel(),
      noTools: "builtin",
    });
    t.after(() => session.dispose());
    await session.bindExtensions({});
    assert.ok(api);

    let hiddenSeen = false;
    // Every subset of the candidates, in one session, so later requests also
    // replay earlier additions and removals through Pi's projection.
    for (let mask = 0; mask < 2 ** CANDIDATES.length; mask++) {
      const selected = CANDIDATES.filter((_name, index) => (mask & (1 << index)) !== 0);
      session.setActiveToolsByName(selected);
      let request: Message[] | undefined;
      faux.setResponses([
        (context) => {
          request = [...context.messages];
          return fauxAssistantMessage("ok");
        },
      ]);
      await session.prompt(`Loadout ${String(mask)}`, { expandPromptTemplates: false });
      assert.ok(request, `Pi sent no request for loadout ${String(mask)}`);

      // Compaction projects the session transcript from its current tools,
      // which Pi recorded for this request.
      const transcript = convertToLlm(session.sessionManager.buildSessionContext().messages);
      const transcriptNames = names(getCurrentTools(transcript));
      assert.deepEqual(transcriptNames, session.getActiveToolNames().toSorted());
      const projected = projectCodemodeTranscript(api, transcript, transcriptNames);
      if (codemodeHiddenTools(transcriptNames, api.getAllTools(), api.getSettings()).size > 0) {
        hiddenSeen = true;
      }
      const label = `loadout [${selected.join(", ")}]`;
      assert.deepEqual(
        names(getCurrentTools(projected)),
        names(getCurrentTools(request)),
        `current tools for ${label}`,
      );
      assert.deepEqual(
        declarations(getCurrentTools(projected)),
        declarations(getCurrentTools(request)),
        `current declarations for ${label}`,
      );
      assert.deepEqual(
        names(getDeclaredTools(projected)),
        names(getDeclaredTools(request)),
        `declared tools for ${label}`,
      );
    }
    assert.equal(hiddenSeen, mode === "only");
  });
}

test("hides active direct tools only while codemode is active in only mode", () => {
  const allTools = [
    { name: CODEMODE_TOOL_NAME, exposure: "model-only" as const },
    { name: "direct_alpha", exposure: "direct" as const },
    { name: "model_only", exposure: "model-only" as const },
  ];
  const active = allTools.map((tool) => tool.name);
  assert.deepEqual(
    [...codemodeHiddenTools(active, allTools, { codemode: { mode: "only" } })],
    ["direct_alpha"],
  );
  assert.equal(codemodeHiddenTools(active, allTools, { codemode: { mode: "on" } }).size, 0);
  assert.equal(codemodeHiddenTools(active, allTools, {}).size, 0);
  assert.equal(
    codemodeHiddenTools(active.slice(1), allTools, { codemode: { mode: "only" } }).size,
    0,
  );
});
