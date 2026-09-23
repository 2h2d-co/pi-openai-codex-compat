import test from "node:test";
import { verifyPackagedCli } from "./support/codex-cli-harness.ts";

for (const modelId of ["gpt-5.6-luna", "gpt-6-sol", "gpt-6-luna"]) {
  for (const lite of [false, true]) {
    test(
      `packaged Pi CLI ${modelId} transcript lifecycle (Lite=${String(lite)})`,
      {
        timeout: 120_000,
      },
      async (t) => verifyPackagedCli(t, { live: false, lite, modelId }),
    );
  }
}
