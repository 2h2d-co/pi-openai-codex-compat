import test from "node:test";
import { verifyPackagedCli } from "./support/codex-cli-harness.ts";

for (const lite of [false, true]) {
  test(
    `packaged Pi CLI transcript lifecycle (Lite=${String(lite)})`,
    {
      timeout: 120_000,
    },
    async (t) => verifyPackagedCli(t, { live: false, lite }),
  );
}
