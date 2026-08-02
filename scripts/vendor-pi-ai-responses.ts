#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM_PACKAGE = "@earendil-works/pi-ai";
const ENTRYPOINTS = ["src/api/openai-responses-shared.ts"] as const;
const MANIFEST_FILE = "manifest.json";
const README_FILE = "README.md";
const SCHEMA_VERSION = 1;
const VENDORED_HEADER =
  "// @ts-nocheck -- Generated from pi-ai; run `npm run vendor:pi-ai` instead of editing.\n";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const vendorRoot = path.join(repositoryRoot, "extensions/openai-codex-compat/vendor/pi-ai");
const checkOnly = process.argv.slice(2).includes("--check");

if (process.argv.slice(2).some((argument) => argument !== "--check")) {
  throw new Error("Usage: node scripts/vendor-pi-ai-responses.ts [--check]");
}

type SourceFile = {
  content: string;
  sourceMap: string;
};

type Manifest = {
  schemaVersion: number;
  package: string;
  version: string;
  entrypoints: string[];
  files: Record<string, { upstreamSha256: string; vendoredSha256: string; sourceMap: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") return false;
    throw error;
  }
}

async function walkFiles(directory: string): Promise<string[]> {
  if (!(await exists(directory))) return [];

  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  };
  await visit(directory);
  return files.sort();
}

async function findPackageRoot(): Promise<string> {
  let current = path.dirname(fileURLToPath(import.meta.resolve(UPSTREAM_PACKAGE)));

  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (await exists(packageJsonPath)) {
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
      if (isRecord(packageJson) && packageJson["name"] === UPSTREAM_PACKAGE) return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not locate the installed ${UPSTREAM_PACKAGE} package root.`);
    }
    current = parent;
  }
}

async function packageVersion(packageRoot: string): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as unknown;
  if (!isRecord(packageJson) || typeof packageJson["version"] !== "string") {
    throw new Error(`${UPSTREAM_PACKAGE}/package.json has no string version.`);
  }
  return packageJson["version"];
}

async function sourceMapIndex(packageRoot: string): Promise<Map<string, SourceFile>> {
  const distRoot = path.join(packageRoot, "dist");
  const mapPaths = (await walkFiles(distRoot)).filter((filePath) => filePath.endsWith(".js.map"));
  const sources = new Map<string, SourceFile>();

  for (const mapPath of mapPaths) {
    const sourceMap = JSON.parse(await readFile(mapPath, "utf8")) as unknown;
    if (!isRecord(sourceMap)) continue;
    const mapSources = sourceMap["sources"];
    const mapSourcesContent = sourceMap["sourcesContent"];
    if (!Array.isArray(mapSources) || !Array.isArray(mapSourcesContent)) continue;
    const sourceRoot = typeof sourceMap["sourceRoot"] === "string" ? sourceMap["sourceRoot"] : "";

    for (let index = 0; index < mapSources.length; index++) {
      const source = mapSources[index];
      const content = mapSourcesContent[index];
      if (typeof source !== "string" || typeof content !== "string") continue;

      const absoluteSource = path.resolve(path.dirname(mapPath), sourceRoot, source);
      const relativeSource = path.relative(packageRoot, absoluteSource);
      if (relativeSource.startsWith("..") || path.isAbsolute(relativeSource)) continue;

      const sourcePath = toPosix(relativeSource);
      const sourceMapPath = toPosix(path.relative(packageRoot, mapPath));
      const existing = sources.get(sourcePath);
      if (existing && existing.content !== content) {
        throw new Error(
          `${UPSTREAM_PACKAGE} source maps disagree about the contents of ${sourcePath}.`,
        );
      }
      sources.set(sourcePath, { content, sourceMap: sourceMapPath });
    }
  }

  if (sources.size === 0) {
    throw new Error(
      `${UPSTREAM_PACKAGE} does not publish source maps with embedded TypeScript sources.`,
    );
  }
  return sources;
}

/** Find static imports, re-exports, dynamic imports, and CommonJS requires. */
function moduleSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^;]*?\bfrom\s*(["'])([^"'\r\n]+)\1/g,
    /\bimport\s*(["'])([^"'\r\n]+)\1/g,
    /\b(?:import|require)\s*\(\s*(["'])([^"'\r\n]+)\1\s*\)/g,
    /\/\/\/\s*<reference\s+path\s*=\s*(["'])([^"'\r\n]+)\1/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[2];
      if (specifier) specifiers.add(specifier);
    }
  }
  return [...specifiers].sort();
}

function resolveSourceImport(
  importer: string,
  specifier: string,
  sources: ReadonlyMap<string, SourceFile>,
): string | undefined {
  const unresolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  const extension = path.posix.extname(unresolved);
  const candidates = new Set<string>([unresolved]);

  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    const stem = unresolved.slice(0, -extension.length);
    candidates.add(`${stem}.ts`);
    candidates.add(`${stem}.tsx`);
    candidates.add(`${stem}.mts`);
    candidates.add(`${stem}.cts`);
  } else if (!extension) {
    candidates.add(`${unresolved}.ts`);
    candidates.add(`${unresolved}.tsx`);
    candidates.add(`${unresolved}/index.ts`);
    candidates.add(`${unresolved}/index.tsx`);
  }

  return [...candidates].find((candidate) => sources.has(candidate));
}

function dependencyClosure(sources: ReadonlyMap<string, SourceFile>): Map<string, SourceFile> {
  const pending: string[] = [...ENTRYPOINTS];
  const selected = new Map<string, SourceFile>();
  const unresolved: string[] = [];

  while (pending.length > 0) {
    const sourcePath = pending.pop()!;
    if (selected.has(sourcePath)) continue;

    const source = sources.get(sourcePath);
    if (!source) {
      unresolved.push(sourcePath);
      continue;
    }
    selected.set(sourcePath, source);

    for (const specifier of moduleSpecifiers(source.content)) {
      if (!specifier.startsWith(".")) continue;
      const dependency = resolveSourceImport(sourcePath, specifier, sources);
      if (dependency) {
        pending.push(dependency);
      } else {
        unresolved.push(`${sourcePath} -> ${specifier}`);
      }
    }
  }

  if (unresolved.length > 0) {
    throw new Error(
      `Could not vendor the complete ${UPSTREAM_PACKAGE} source dependency closure:\n${unresolved
        .sort()
        .map((item) => `- ${item}`)
        .join("\n")}`,
    );
  }

  return new Map([...selected].sort(([left], [right]) => left.localeCompare(right)));
}

function vendoredContent(source: string): string {
  return `${VENDORED_HEADER}${source}`;
}

function manifestFor(version: string, sources: ReadonlyMap<string, SourceFile>): Manifest {
  return {
    schemaVersion: SCHEMA_VERSION,
    package: UPSTREAM_PACKAGE,
    version,
    entrypoints: [...ENTRYPOINTS],
    files: Object.fromEntries(
      [...sources].map(([sourcePath, source]) => {
        const vendored = vendoredContent(source.content);
        return [
          sourcePath,
          {
            upstreamSha256: sha256(source.content),
            vendoredSha256: sha256(vendored),
            sourceMap: source.sourceMap,
          },
        ];
      }),
    ),
  };
}

function readmeFor(version: string, fileCount: number): string {
  return `# Vendored Pi AI Responses serialization\n\nThis directory is generated from \`${UPSTREAM_PACKAGE}@${version}\`. Do not edit it manually.\n\nIt contains the ${fileCount}-file TypeScript dependency closure rooted at \`${ENTRYPOINTS[0]}\`, extracted from the installed package's source maps. Each file has one generated \`@ts-nocheck\` header followed by the verbatim upstream source.\n\nUpdate it after changing the Pi dependencies:\n\n\`\`\`sh\nnpm run vendor:pi-ai\n\`\`\`\n\nCheck that it is complete and current:\n\n\`\`\`sh\nnpm run vendor:pi-ai:check\n\`\`\`\n\nUpstream: <https://github.com/earendil-works/pi/tree/main/packages/ai>\n\nLicense: MIT; see [\`LICENSES/pi-ai-MIT.txt\`](../../../../LICENSES/pi-ai-MIT.txt).\n`;
}

function expectedFiles(
  version: string,
  sources: ReadonlyMap<string, SourceFile>,
): Map<string, string> {
  const manifest = manifestFor(version, sources);
  return new Map([
    ...[...sources].map(
      ([sourcePath, source]) => [sourcePath, vendoredContent(source.content)] as const,
    ),
    [MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`],
    [README_FILE, readmeFor(version, sources.size)],
  ]);
}

async function consistencyErrors(expected: ReadonlyMap<string, string>): Promise<string[]> {
  const actualPaths = (await walkFiles(vendorRoot)).map((filePath) =>
    toPosix(path.relative(vendorRoot, filePath)),
  );
  const errors: string[] = [];

  for (const relativePath of expected.keys()) {
    if (!actualPaths.includes(relativePath)) {
      errors.push(`missing ${relativePath}`);
      continue;
    }
    const actual = await readFile(path.join(vendorRoot, relativePath), "utf8");
    if (actual !== expected.get(relativePath)) errors.push(`outdated ${relativePath}`);
  }
  for (const relativePath of actualPaths) {
    if (!expected.has(relativePath)) errors.push(`unexpected ${relativePath}`);
  }
  return errors.sort();
}

async function assertSafeToUpdate(expected: ReadonlyMap<string, string>): Promise<void> {
  const actualPaths = (await walkFiles(vendorRoot)).map((filePath) =>
    toPosix(path.relative(vendorRoot, filePath)),
  );
  if (actualPaths.length === 0) return;

  const manifestPath = path.join(vendorRoot, MANIFEST_FILE);
  if (!(await exists(manifestPath))) {
    throw new Error(`Refusing to update ${vendorRoot}: its generated manifest is missing.`);
  }

  const previous = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  if (!isRecord(previous) || !isRecord(previous["files"])) {
    throw new Error(`Refusing to update ${vendorRoot}: its generated manifest is invalid.`);
  }
  const known = new Set([MANIFEST_FILE, README_FILE, ...Object.keys(previous["files"])]);
  const unknown = actualPaths.filter((relativePath) => !known.has(relativePath));
  if (unknown.length > 0) {
    throw new Error(
      `Refusing to overwrite unrecognized files under ${vendorRoot}:\n${unknown
        .map((filePath) => `- ${filePath}`)
        .join("\n")}`,
    );
  }

  for (const relativePath of actualPaths) {
    if (!expected.has(relativePath)) await rm(path.join(vendorRoot, relativePath));
  }
}

async function update(expected: ReadonlyMap<string, string>): Promise<void> {
  await assertSafeToUpdate(expected);
  for (const [relativePath, content] of expected) {
    const destination = path.join(vendorRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
}

const packageRoot = await findPackageRoot();
const version = await packageVersion(packageRoot);
const allSources = await sourceMapIndex(packageRoot);
const sources = dependencyClosure(allSources);
const expected = expectedFiles(version, sources);

if (!checkOnly) await update(expected);

const errors = await consistencyErrors(expected);
if (errors.length > 0) {
  throw new Error(
    `Vendored ${UPSTREAM_PACKAGE} sources are inconsistent with ${version}:\n${errors
      .map((error) => `- ${error}`)
      .join("\n")}\nRun npm run vendor:pi-ai to update them.`,
  );
}

console.log(
  `${checkOnly ? "Verified" : "Updated"} ${sources.size} vendored source files from ${UPSTREAM_PACKAGE}@${version}.`,
);
