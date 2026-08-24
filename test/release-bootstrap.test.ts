import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps pre-install release validation dependency-free", async () => {
  const source = await readFile(
    new URL("../scripts/ci-publish-checks.ts", import.meta.url),
    "utf8",
  );
  const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gmu)].map((match) => match[1]);

  assert.ok(imports.length > 0);
  assert.ok(
    imports.every((specifier) => specifier?.startsWith("node:")),
    `pre-install release validation imports project dependencies: ${imports.join(", ")}`,
  );
});
