import { performance } from "node:perf_hooks";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CodexToolBackgroundResolver } from "./codex-tool-surface.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import {
  applyPatchDiagnosticError,
  prepareApplyPatchDiagnostics,
  writeApplyPatchDiagnosticsOutcome,
  writeApplyPatchDiagnosticsRequest,
  type ApplyPatchDiagnosticsContext,
  type PreparedApplyPatchDiagnostics,
} from "./apply-patch-diagnostics.ts";
import {
  applyPatch,
  type ApplyPatchDetails,
  ApplyPatchExecutionError,
  ApplyPatchInputError,
  ApplyPatchVerificationError,
  formatApplyPatchFailureSummary,
  formatApplyPatchModelOutput,
  formatApplyPatchSummary,
} from "./apply-patch-engine.ts";
import {
  type ApplyPatchDebugResolver,
  renderApplyPatchCall,
  renderApplyPatchResult,
} from "./apply-patch-render.ts";
import type { ToolDefinitionWithContext } from "./tool-definition-contract.ts";

export {
  applyPatch,
  type ApplyPatchDetails,
  type ApplyPatchDiagnosticsReference,
  type ApplyPatchExecutionFilesystem,
  type ApplyPatchExecutionHooks,
  type ApplyPatchFailureDetails,
  type ApplyPatchInstructionDetails,
  type ApplyPatchInstructionEffect,
  type ApplyPatchInstructionReason,
  type ApplyPatchInstructionReasonCode,
  type ApplyPatchInstructionStatus,
  type ApplyPatchFinalPathState,
  type AppliedPatchChange,
  ApplyPatchExecutionError,
  ApplyPatchInputError,
  ApplyPatchParseError,
  ApplyPatchVerificationError,
  type ParsedPatch,
  type PatchOperation,
  type UpdateChunk,
  parsePatch,
  parsePatchDocument,
} from "./apply-patch-engine.ts";

export const APPLY_PATCH_TOOL_NAME = "apply_patch";
export const APPLY_PATCH_INPUT_PROPERTY = "patch";
const APPLY_PATCH_PARAMETERS = Type.Object({
  patch: Type.String({ description: "Raw patch text beginning with *** Begin Patch" }),
});

export type ApplyPatchTool = ToolDefinitionWithContext<
  typeof APPLY_PATCH_PARAMETERS,
  ApplyPatchDetails,
  Record<string, never>,
  Pick<ExtensionContext, "cwd"> & {
    sessionManager?: ApplyPatchDiagnosticsContext["sessionManager"];
  }
>;

export type ApplyPatchApi = {
  on: (
    event: "tool_result",
    handler: (
      event: Pick<ToolResultEvent, "toolCallId" | "toolName">,
    ) => { details: ApplyPatchDetails } | undefined,
  ) => void;
  registerTool: (tool: ApplyPatchTool) => void;
};

// Adapted from OpenAI Codex's Apache-2.0 apply_patch grammar; see
// THIRD_PARTY_NOTICES.md. Pi serializes it as a native custom grammar tool for
// capable models and falls back to an ordinary function tool elsewhere.
export const APPLY_PATCH_LARK_GRAMMAR = String.raw`start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF`;

export default function registerApplyPatch(
  pi: ApplyPatchApi,
  resolveToolBackground: CodexToolBackgroundResolver = () => DEFAULT_CONFIG.toolBackground,
  resolveDebug: ApplyPatchDebugResolver = () => DEFAULT_CONFIG.applyPatchDebug,
  resolveDiagnostics: () => boolean = () => DEFAULT_CONFIG.applyPatchDiagnostics,
): void {
  const failedDetails = new Map<string, ApplyPatchDetails>();

  pi.on("tool_result", (event) => {
    if (event.toolName !== APPLY_PATCH_TOOL_NAME) return;
    const details = failedDetails.get(event.toolCallId);
    if (!details) return;
    failedDetails.delete(event.toolCallId);
    return { details };
  });

  pi.registerTool({
    name: APPLY_PATCH_TOOL_NAME,
    label: APPLY_PATCH_TOOL_NAME,
    description:
      "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
    promptSnippet: "Apply freeform patches to add, update, move, or delete files",
    promptGuidelines: [
      "Use `apply_patch` for local file edits.",
      "Do not create or edit files with `cat` or other shell write tricks.",
      "Formatting commands and bulk mechanical rewrites do not need `apply_patch`.",
    ],
    parameters: APPLY_PATCH_PARAMETERS,
    constrainedSampling: {
      type: "grammar",
      variants: { openai_lark: APPLY_PATCH_LARK_GRAMMAR },
    },
    executionMode: "sequential",
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const diagnosticsStartedAt = performance.now();
      let preparedDiagnostics: PreparedApplyPatchDiagnostics | undefined;
      if (resolveDiagnostics()) {
        if (!ctx.sessionManager) {
          throw new Error("apply_patch diagnostics require Pi session context.");
        }
        preparedDiagnostics = await prepareApplyPatchDiagnostics(
          { cwd: ctx.cwd, sessionManager: ctx.sessionManager },
          toolCallId,
          params.patch,
        );
      }
      let executionStartedAt: number | undefined;
      const executionDurationMs = (): number => {
        if (executionStartedAt === undefined) {
          throw new Error("apply_patch execution timing was not initialized.");
        }
        return performance.now() - executionStartedAt;
      };
      try {
        const details = await applyPatch(ctx.cwd, params.patch, signal, {
          onExecutionStart() {
            executionStartedAt = performance.now();
          },
          onProgress(partialDetails) {
            onUpdate?.({
              content: [{ type: "text", text: "" }],
              details: partialDetails,
            });
          },
        });
        return {
          content: [
            {
              type: "text",
              text: formatApplyPatchModelOutput(
                0,
                executionDurationMs(),
                formatApplyPatchSummary(details, ctx.cwd),
              ),
            },
          ],
          details,
        };
      } catch (error) {
        const errorDetails =
          error instanceof ApplyPatchExecutionError ||
          error instanceof ApplyPatchVerificationError ||
          (error instanceof ApplyPatchInputError && error.details)
            ? error.details
            : undefined;
        if (preparedDiagnostics) {
          const diagnostics = preparedDiagnostics.reference;
          try {
            await writeApplyPatchDiagnosticsRequest(preparedDiagnostics);
            if (errorDetails) errorDetails.diagnostics = diagnostics;
            const failedOutcome: Parameters<typeof writeApplyPatchDiagnosticsOutcome>[1] = {
              status: "failed",
              durationMs: performance.now() - diagnosticsStartedAt,
              error: applyPatchDiagnosticError(error),
            };
            if (errorDetails) failedOutcome.details = errorDetails;
            try {
              await writeApplyPatchDiagnosticsOutcome(diagnostics, failedOutcome);
            } catch (outcomeError) {
              console.error(
                `Could not write apply_patch diagnostics outcome ${diagnostics.recordId}:`,
                outcomeError,
              );
            }
          } catch (requestError) {
            console.error(
              `Could not write apply_patch diagnostics request ${diagnostics.recordId}:`,
              requestError,
            );
          }
        }
        if (error instanceof ApplyPatchExecutionError) {
          failedDetails.set(toolCallId, error.details);
          throw new Error(
            formatApplyPatchModelOutput(
              1,
              executionDurationMs(),
              formatApplyPatchFailureSummary(error.details, ctx.cwd),
            ),
            { cause: error },
          );
        }
        if (error instanceof ApplyPatchVerificationError) {
          failedDetails.set(toolCallId, error.details);
          throw new Error(formatApplyPatchFailureSummary(error.details, ctx.cwd), {
            cause: error,
          });
        } else if (error instanceof ApplyPatchInputError && error.details) {
          failedDetails.set(toolCallId, error.details);
          throw new Error(formatApplyPatchFailureSummary(error.details, ctx.cwd), {
            cause: error,
          });
        }
        throw error;
      }
    },
    renderCall(args, theme, context) {
      return renderApplyPatchCall(args, theme, context, resolveToolBackground, resolveDebug);
    },
    renderResult(result, options, theme, context) {
      return renderApplyPatchResult(
        result,
        options,
        theme,
        context,
        resolveToolBackground,
        resolveDebug,
      );
    },
  });
}
