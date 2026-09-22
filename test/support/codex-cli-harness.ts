import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js";
import {
  parseJsonRecord,
  requireJsonRecord,
  requireJsonRecords,
} from "../../extensions/openai-codex-compat/codex-protocol.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = join(root, "test/support/codex-cli-extension.ts");
const instruction = (marker: string) =>
  `The current system marker is ${marker}. Call verify_release exactly once with that marker ` +
  "and the value from the latest user message. Do not respond with text.";

/**
 * Give the extracted package the dependency layout `pi install` produces: only its
 * production dependency closure is present. The `@earendil-works/*` packages stay
 * absent so every such import must resolve through Pi's extension aliases, which
 * exclude subpaths like `pi-ai/api/*`. Linking the whole repository `node_modules`
 * would hide that class of failure.
 */
async function linkProductionDependencies(packageRoot: string): Promise<void> {
  const modules = join(packageRoot, "node_modules");
  await mkdir(modules);
  const closure = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter((path) => path.startsWith(`${root}/node_modules/`))
    .map((path) => path.slice(`${root}/node_modules/`.length))
    .filter((name) => !name.includes("/node_modules/"));
  assert.ok(closure.length > 0, "The package declares production dependencies.");
  for (const name of new Set(closure)) {
    assert.doesNotMatch(name, /^@earendil-works\//, `${name} must resolve through Pi's aliases.`);
    if (name.includes("/")) await mkdir(join(modules, dirname(name)), { recursive: true });
    await symlink(join(root, "node_modules", name), join(modules, name), "dir");
  }
  assert.equal(existsSync(join(modules, "@earendil-works")), false);
}

export async function verifyPackagedCli(
  t: TestContext,
  options: { live: boolean; lite: boolean },
): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "codex-packaged-cli-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const agent = join(temporary, "agent");
  await mkdir(agent);
  let archive = process.env["PI_CODEX_PACKAGE_ARCHIVE"];
  if (!archive) {
    const packed = requireJsonRecords(
      JSON.parse(
        execFileSync(
          "npm",
          [
            "pack",
            "--json",
            "--ignore-scripts",
            "--allow-directory=all",
            "--pack-destination",
            temporary,
          ],
          { cwd: root, encoding: "utf8" },
        ),
      ),
    );
    assert.equal(packed.length, 1);
    const filename = packed[0]?.["filename"];
    assert.ok(typeof filename === "string");
    archive = join(temporary, filename);
  }
  const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .trim()
    .split("\n")
    .sort();
  const expected = (await readFile(join(root, ".github/npm-package-files"), "utf8"))
    .trim()
    .split("\n")
    .map((file) => `package/${file}`)
    .sort();
  assert.deepEqual(files, expected);
  execFileSync("tar", ["-xzf", archive, "-C", temporary]);
  const packageRoot = join(temporary, "package");
  const packaged = parseJsonRecord(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(packaged["name"], "pi-openai-codex-compat");
  const packageVersion = packaged["version"];
  assert.ok(typeof packageVersion === "string");
  await linkProductionDependencies(packageRoot);

  const cli = await realpath(
    process.env["PI_CODEX_CLI_PATH"] ??
      join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
  );
  const piRoot = resolve(dirname(cli), "../..");
  const piManifest = parseJsonRecord(await readFile(join(piRoot, "package.json"), "utf8"));
  assert.equal(piManifest["version"], "0.87.0");
  const token = options.live
    ? process.env["PI_CODEX_LIVE_API_KEY"]
    : `test.${Buffer.from(
        JSON.stringify({
          "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
        }),
      ).toString("base64url")}.test`;
  assert.ok(token, "The live CLI test requires PI_CODEX_LIVE_API_KEY");
  await writeFile(
    join(agent, "models.json"),
    JSON.stringify({
      providers: { "openai-codex": { apiKey: "$PI_CODEX_LIVE_API_KEY" } },
    }),
  );
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({
      transport: "sse",
      retry: { enabled: false, provider: { timeoutMs: 60_000, maxRetries: 0 } },
      compaction: { enabled: false, keepRecentTokens: 1 },
      // Pi's built-in read tool joins later in the lifecycle: its strict JSON-schema
      // sampling must serialize into the strict subset Codex accepts, and its
      // mid-session addition must survive a provider-boundary checkpoint.
      defaultTools: ["verify_release"],
    }),
  );
  const writeCompatConfig = async (overrides: Record<string, unknown> = {}) =>
    writeFile(
      join(agent, "openai-codex-compat.json"),
      JSON.stringify({
        responsesLite: options.lite,
        fastMode: false,
        applyPatch: false,
        imageGeneration: false,
        webRun: false,
        webSearch: "disabled",
        ...overrides,
      }),
    );
  await writeCompatConfig();
  await writeFile(join(agent, "SYSTEM.md"), instruction("FIRST"));
  const sessionFile = join(temporary, "session.jsonl");
  const clientOptions = {
    cliPath: cli,
    cwd: temporary,
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    env: {
      HOME: temporary,
      PI_CODING_AGENT_DIR: agent,
      PI_PACKAGE_DIR: piRoot,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_CODEX_LIVE_API_KEY: token,
      PI_CODEX_CLI_MOCK: options.live ? "0" : "1",
    },
    args: [
      "--offline",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--thinking",
      "medium",
      "--session",
      sessionFile,
      "-e",
      packageRoot,
      "-e",
      fixture,
    ],
  };
  assert.equal(
    execFileSync(process.execPath, [cli, "--version"], {
      env: { ...process.env, ...clientOptions.env },
      encoding: "utf8",
    }).trim(),
    "0.87.0",
  );
  let client = new RpcClient(clientOptions);
  t.after(async () => client.stop());
  await client.start();
  assert.ok((await client.getCommands()).some((command) => command.name === "codex-settings"));

  async function turn(
    marker: string,
    value: string,
    expectedTools: readonly string[] = ["read", "verify_release"],
    leadingMarker: string = marker,
  ): Promise<void> {
    const events = await client.promptAndWait(`user value: ${value}`, undefined, 90_000);
    assert.deepEqual(
      events.filter((event: { type: string }) => event.type === "extension_error"),
      [],
    );
    const messages = await client.getMessages();
    const assistant = messages.filter((message) => message.role === "assistant").at(-1);
    assert.ok(assistant);
    assert.equal(
      assistant.stopReason,
      "toolUse",
      assistant.errorMessage ?? JSON.stringify(assistant.content),
    );
    const call = assistant.content.find((block) => block.type === "toolCall");
    assert.ok(call);
    assert.equal(call.name, "verify_release");
    assert.deepEqual(call.arguments, { marker, value });
    const diagnostic = assistant.diagnostics?.find(
      (entry) => entry.type === "codex_transport_request",
    );
    assert.ok(diagnostic);
    assert.equal(
      requireJsonRecord(diagnostic.details?.["cache"])["envelope"],
      options.lite ? "responses_lite" : "responses",
    );
    const { entries } = await client.getEntries();
    const observation = entries
      .filter((entry) => entry.type === "custom" && entry.customType === "release-test-request")
      .at(-1);
    assert.ok(observation?.type === "custom");
    const data = requireJsonRecord(observation.data);
    assert.equal(data["marker"], marker);
    assert.equal(data["leadingMarker"], leadingMarker);
    const tools = data["tools"];
    assert.ok(Array.isArray(tools));
    const byName = (left: unknown, right: unknown) => String(left).localeCompare(String(right));
    assert.deepEqual([...tools].sort(byName), [...expectedTools].sort(byName));
    // Tool declarations never travel inside `input`.
    assert.deepEqual(data["inlineTools"], []);
    assert.doesNotMatch(client.getStderr(), /Failed to load extension|not a function/);
  }

  await turn("FIRST", "alpha", ["verify_release"]);
  await writeFile(join(agent, "SYSTEM.md"), instruction("SECOND"));
  await client.prompt("/release-test-reload");
  // The leading prompt stays in `instructions`; the reload arrives as an
  // inline developer update, so the model must follow the newest marker.
  await turn("SECOND", "bravo", ["verify_release"], "FIRST");
  const compacted = await client.compact();
  assert.match(compacted.summary, /OpenAI Codex remote compaction checkpoint/);
  // Pi rebuilds its transcript from the checkpoint snapshot, which now leads
  // with the reloaded prompt.
  await turn("SECOND", "charlie", ["verify_release"]);
  // Add a tool after the manual checkpoint, then let a percentage-triggered
  // checkpoint replace the history that declared it. The runtime appends that
  // checkpoint itself, so Pi keeps its pre-checkpoint transcript in memory for
  // the following turns. Every request must still declare the complete current
  // set at the top level, including a tool added after the checkpoint.
  await writeCompatConfig({ autoCompactAtPercent: 0.01 });
  await client.prompt("/release-test-reload");
  await client.prompt("/release-test-tools read,verify_release");
  await turn("SECOND", "echo");
  const boundary = (await client.getEntries()).entries.findLast(
    (entry) => entry.type === "compaction",
  );
  assert.ok(boundary?.type === "compaction");
  assert.deepEqual(requireJsonRecord(boundary.details)["compactionDecision"], {
    reason: "provider-boundary",
    willRetry: true,
  });
  await writeCompatConfig();
  await client.prompt("/release-test-reload");
  await client.prompt("/release-test-tools read,verify_release,write");
  await turn("SECOND", "foxtrot", ["read", "verify_release", "write"]);
  await client.stop();
  client = new RpcClient(clientOptions);
  await client.start();
  // Resume rebuilds Pi's transcript from the checkpoint but restores the
  // configured default loadout, so declare the same tools again before prompting.
  await client.prompt("/release-test-tools read,verify_release,write");
  await turn("SECOND", "golf", ["read", "verify_release", "write"]);
  const { entries } = await client.getEntries();
  const requests = entries.flatMap((entry) =>
    entry.type === "custom" && entry.customType === "release-test-request"
      ? [requireJsonRecord(entry.data)]
      : [],
  );
  assert.equal(requests.at(-1)?.["checkpoint"], true);
  await client.stop();
  t.diagnostic(
    `Pi ${String(piManifest["version"])} packaged ${packageVersion}: ` +
      `${options.lite ? "Lite" : "Responses"}, tools, reload, native compaction, ` +
      "percentage checkpoint, and resume passed",
  );
}
