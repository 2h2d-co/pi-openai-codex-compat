import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXTENSION_ID = "openai-codex-compat";
const DISPLAY_NAME = "OpenAI Codex Compat";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("codex-compat", {
    description: "Show OpenAI Codex compatibility status",
    handler: async (args, ctx) => {
      const subject = args.trim() || "world";
      const message = `${DISPLAY_NAME}: hello ${subject}`;
      if (ctx.hasUI) {
        ctx.ui.notify(message, "info");
      } else {
        console.log(message);
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus(EXTENSION_ID, "loaded");
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus(EXTENSION_ID, undefined);
    }
  });
}
