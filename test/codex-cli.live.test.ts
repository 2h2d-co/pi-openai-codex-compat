import test from "node:test";
import { verifyPackagedCli } from "./support/codex-cli-harness.ts";

for (const modelId of ["gpt-5.6-luna", "gpt-6-sol", "gpt-6-luna"]) {
  for (const lite of [false, true]) {
    test(
      `live packaged Pi CLI ${modelId} transcript lifecycle (Lite=${String(lite)})`,
      {
        skip: process.env["PI_CODEX_LIVE_TEST"] !== "1",
        timeout: 240_000,
      },
      async (t) => verifyPackagedCli(t, { live: true, lite, modelId }),
    );
  }
}
