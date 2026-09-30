import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

/** Name of Pi's built-in codemode tool. */
export const CODEMODE_TOOL_NAME = "codemode";

export type CodemodeLoadoutApi = Pick<ExtensionAPI, "getAllTools" | "getSettings">;

/**
 * Tools Pi 0.99.1 leaves out of every request while its built-in codemode tool
 * is active in `only` mode. Codemode's `prepareLoadout` hook returns them as
 * `hiddenDeclarations`, and Pi removes them from the transcript it passes to the
 * provider. Pi exposes neither the hook's result nor that projection to
 * extensions, so native compaction, which builds its own request, applies the
 * same rule: every active `direct` tool except `codemode` itself.
 *
 * `codemode-loadout.test.ts` compares this rule with Pi's real codemode for
 * every combination of mode, exposure, and active tools, so a Pi update that
 * changes the rule fails the tests. An extension that replaces the built-in
 * `codemode` tool, or another tool that hides declarations, is not mirrored.
 */
export function codemodeHiddenTools(
  activeNames: readonly string[],
  allTools: readonly Pick<ToolInfo, "name" | "exposure">[],
  settings: ReturnType<ExtensionAPI["getSettings"]>,
): ReadonlySet<string> {
  if (settings.codemode?.mode !== "only" || !activeNames.includes(CODEMODE_TOOL_NAME)) {
    return new Set();
  }
  const exposures = new Map(allTools.map((tool) => [tool.name, tool.exposure]));
  return new Set(
    activeNames.filter((name) => name !== CODEMODE_TOOL_NAME && exposures.get(name) === "direct"),
  );
}

/**
 * Project a transcript as Pi 0.99.1 projects it for a request with this
 * transcript's current tools. Pi records tool changes right before each request,
 * so a transcript's current tools are the loadout of its latest request, even
 * after a resume that restored a different loadout. Hidden tools leave every
 * tool declaration change; system messages keep their prompt content.
 */
export function projectCodemodeTranscript(
  pi: CodemodeLoadoutApi,
  messages: readonly Message[],
  currentToolNames: readonly string[],
): Message[] {
  const hidden = codemodeHiddenTools(currentToolNames, pi.getAllTools(), pi.getSettings());
  if (hidden.size === 0) return [...messages];
  return messages.map((message) => {
    if (message.role !== "system" || (!message.toolsAdded && !message.toolsRemoved)) {
      return message;
    }
    const { toolsAdded, toolsRemoved, ...rest } = message;
    const added = toolsAdded?.filter((tool) => !hidden.has(tool.name)) ?? [];
    const removed = toolsRemoved?.filter((tool) => !hidden.has(tool.name)) ?? [];
    return {
      ...rest,
      ...(added.length > 0 ? { toolsAdded: added } : {}),
      ...(removed.length > 0 ? { toolsRemoved: removed } : {}),
    };
  });
}
