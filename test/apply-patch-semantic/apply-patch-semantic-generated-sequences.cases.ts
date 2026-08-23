import { requiredValue } from "../../extensions/openai-codex-compat/required-value.ts";
import {
  assert,
  chmod,
  readFile,
  readdir,
  stat,
  writeFile,
  join,
  test,
  applyPatch,
  workspace,
  patch,
} from "./apply-patch-semantic-harness.ts";

const GENERATED_PATHS = ["a.txt", "b.txt", "c.txt", "d.txt"] as const;
const GENERATED_SEEDS = 32;
const OPERATIONS_PER_SEED = 24;

type GeneratedPath = (typeof GENERATED_PATHS)[number];
type ExpectedFile = {
  content: string;
  mode: number;
};

function randomGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

function renderedPath(path: GeneratedPath, random: () => number): string {
  return random() % 2 === 0 ? path : `./${path}`;
}

function generatedItem<T>(items: readonly T[], random: () => number): T {
  return requiredValue(
    items[random() % items.length],
    "generated selection requires a nonempty item list",
  );
}

test("matches a reference model across generated sequential operation patches", async (t) => {
  const coveredOperationKinds = new Set<string>();
  for (let seed = 1; seed <= GENERATED_SEEDS; seed += 1) {
    const cwd = await workspace(t);
    const random = randomGenerator(seed);
    const expected = new Map<GeneratedPath, ExpectedFile>();
    const initialPath = generatedItem(GENERATED_PATHS, random);
    const initialValue = `initial-${String(seed)}`;
    const initialMode = 0o700 | (seed % 8);
    expected.set(initialPath, { content: initialValue, mode: initialMode });
    await writeFile(join(cwd, initialPath), `${initialValue}\n`);
    await chmod(join(cwd, initialPath), initialMode);

    const instructions: string[] = [];
    for (let operationIndex = 0; operationIndex < OPERATIONS_PER_SEED; operationIndex += 1) {
      const selectedPath = generatedItem(GENERATED_PATHS, random);
      const value = `seed-${String(seed)}-operation-${String(operationIndex)}`;
      switch (random() % 7) {
        case 0: {
          const current = expected.get(selectedPath);
          const content = current !== undefined && random() % 3 === 0 ? current.content : value;
          coveredOperationKinds.add(
            content === current?.content ? "identical-add" : "state-changing-add",
          );
          instructions.push(`*** Add File: ${renderedPath(selectedPath, random)}\n+${content}\n`);
          expected.set(selectedPath, {
            content,
            mode: current?.mode ?? 0o666 & ~process.umask(),
          });
          break;
        }
        case 1: {
          instructions.push(`*** Delete File: ${renderedPath(selectedPath, random)}\n`);
          coveredOperationKinds.add(
            expected.delete(selectedPath) ? "existing-delete" : "absent-delete",
          );
          break;
        }
        case 2: {
          const current = expected.get(selectedPath);
          if (current === undefined) {
            coveredOperationKinds.add("update-fallback-add");
            instructions.push(`*** Add File: ${renderedPath(selectedPath, random)}\n+${value}\n`);
            expected.set(selectedPath, {
              content: value,
              mode: 0o666 & ~process.umask(),
            });
          } else {
            coveredOperationKinds.add("text-update");
            instructions.push(
              `*** Update File: ${renderedPath(selectedPath, random)}\n@@\n-${current.content}\n+${value}\n`,
            );
            expected.set(selectedPath, { ...current, content: value });
          }
          break;
        }
        case 3:
          coveredOperationKinds.add("identity-update");
          instructions.push(
            `*** Update File: ${renderedPath(selectedPath, random)}\n@@\n-${value}\n+${value}\n`,
          );
          break;
        case 4:
          coveredOperationKinds.add("empty-update");
          instructions.push(`*** Update File: ${renderedPath(selectedPath, random)}\n`);
          break;
        case 5: {
          const existingPaths = [...expected.keys()];
          if (existingPaths.length === 0) {
            coveredOperationKinds.add("move-fallback-add");
            instructions.push(`*** Add File: ${renderedPath(selectedPath, random)}\n+${value}\n`);
            expected.set(selectedPath, {
              content: value,
              mode: 0o666 & ~process.umask(),
            });
            break;
          }
          const source = generatedItem(existingPaths, random);
          const possibleDestinations = GENERATED_PATHS.filter((path) => path !== source);
          const destination = generatedItem(possibleDestinations, random);
          coveredOperationKinds.add(expected.has(destination) ? "replacing-move" : "creating-move");
          instructions.push(
            `*** Update File: ${renderedPath(source, random)}\n*** Move to: ${renderedPath(destination, random)}\n`,
          );
          const sourceFile = requiredValue(
            expected.get(source),
            "generated move source must exist",
          );
          expected.set(destination, sourceFile);
          expected.delete(source);
          break;
        }
        default:
          coveredOperationKinds.add("self-move");
          instructions.push(
            `*** Update File: ${renderedPath(selectedPath, random)}\n*** Move to: ${renderedPath(selectedPath, random)}\n`,
          );
      }
    }

    const details = await applyPatch(cwd, patch(...instructions));
    const statuses = details.instructions?.map(({ status }) => status) ?? [];
    assert.equal(statuses.length, instructions.length, `seed ${String(seed)} instruction count`);
    assert.ok(
      statuses.every((status) => status === "applied" || status === "no-op" || status === "dead"),
      `seed ${String(seed)} left a nonterminal instruction status: ${statuses.join(", ")}`,
    );
    assert.equal(
      details.changes.length,
      statuses.filter((status) => status === "applied").length,
      `seed ${String(seed)} applied-change accounting`,
    );
    assert.deepEqual(
      (await readdir(cwd)).sort(),
      [...expected.keys()].sort(),
      `seed ${String(seed)} final paths`,
    );
    for (const [path, file] of expected) {
      assert.equal(
        await readFile(join(cwd, path), "utf8"),
        `${file.content}\n`,
        `seed ${String(seed)} final content for ${path}`,
      );
      assert.equal(
        (await stat(join(cwd, path))).mode & 0o7777,
        file.mode,
        `seed ${String(seed)} final mode for ${path}`,
      );
    }
  }
  assert.deepEqual([...coveredOperationKinds].sort(), [
    "absent-delete",
    "creating-move",
    "empty-update",
    "existing-delete",
    "identical-add",
    "identity-update",
    "move-fallback-add",
    "replacing-move",
    "self-move",
    "state-changing-add",
    "text-update",
    "update-fallback-add",
  ]);
});
