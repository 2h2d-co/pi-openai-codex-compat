#!/usr/bin/env node
import { text } from "node:stream/consumers";
import { runApplyPatchCli } from "../extensions/openai-codex-compat/apply-patch-cli.ts";

process.exitCode = await runApplyPatchCli(process.argv.slice(2), {
  readStdin: () => text(process.stdin),
  writeStdout: (content) => {
    process.stdout.write(content);
  },
  writeStderr: (content) => {
    process.stderr.write(content);
  },
});
