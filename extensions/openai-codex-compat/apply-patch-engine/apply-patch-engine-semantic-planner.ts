import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { deriveNewContent } from "../apply-patch-matcher.ts";
import type {
  AppliedPatchChange,
  ApplyPatchExecutionHooks,
  ApplyPatchInstructionDetails,
  ApplyPatchInstructionReasonCode,
  ResolvedMoveUpdateOperation,
  ResolvedOperation,
  ResolvedUpdateOperation,
} from "./apply-patch-engine-contracts.ts";
import { diffDetails } from "./apply-patch-engine-details.ts";
import { errorMessage, isNotFound, throwIfAborted } from "./apply-patch-engine-errors.ts";
import {
  ABSENT_ENTRY,
  UTF8_DECODER,
  buffersEqual,
  entryType,
  fingerprint,
  type ContentCell,
  type ExistingFileEntry,
  type PlannedAction,
  type PhysicalFileState,
  type PlannedMutation,
  type SemanticPlan,
  type VirtualEntry,
} from "./apply-patch-engine-filesystem-model.ts";
import {
  chunksAreIdentity,
  instructionForOperation,
  instructionReason,
  moveAlreadyFulfilledReason,
  pathIsRelated,
  resolvedUpdateHasMove,
  semanticMoveOperation,
} from "./apply-patch-engine-operation-semantics.ts";
import {
  directoryIsCaseInsensitive,
  namesAlias,
  realpathWithMissingTail,
} from "./apply-patch-engine-path-identity.ts";
import { requiredValue } from "../required-value.ts";

export class SemanticPlanningError extends Error {
  readonly instructions: ApplyPatchInstructionDetails[];
  readonly failedInstruction: number;

  constructor(
    message: string,
    instructions: ApplyPatchInstructionDetails[],
    failedInstruction: number,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.instructions = instructions;
    this.failedInstruction = failedInstruction;
  }
}

export type DeadOperationProof = {
  dominatingInstructions: number[];
};

export class SemanticPlanner {
  private readonly states = new Map<string, VirtualEntry>();
  private readonly physicalFiles = new Map<
    string,
    { content: ContentCell; physical: PhysicalFileState }
  >();
  private readonly actions: PlannedAction[] = [];
  private readonly fulfilledMoves = new Map<
    string,
    { destinationKey: string; destinationEntry: ExistingFileEntry; instruction: number }
  >();
  private exact = true;
  private readonly operations: readonly ResolvedOperation[];
  private readonly instructions: ApplyPatchInstructionDetails[];
  private readonly signal: AbortSignal | undefined;
  private readonly selectMoveStrategy: ApplyPatchExecutionHooks["selectMoveStrategy"] | undefined;
  private readonly pathKeys = new Map<string, string>();
  private readonly inspectionPaths = new Map<string, string>();
  private readonly caseInsensitiveDirectories = new Map<string, Promise<boolean>>();

  constructor(
    operations: readonly ResolvedOperation[],
    signal?: AbortSignal,
    selectMoveStrategy?: ApplyPatchExecutionHooks["selectMoveStrategy"],
  ) {
    this.operations = operations;
    this.instructions = operations.map(instructionForOperation);
    this.signal = signal;
    this.selectMoveStrategy = selectMoveStrategy;
  }

  async plan(): Promise<SemanticPlan> {
    for (const [index, operation] of this.operations.entries()) {
      const instruction = requiredValue(
        this.instructions[index],
        "The current apply_patch instruction is missing.",
      );
      try {
        throwIfAborted(this.signal);
        if (operation.kind === "add") {
          await this.planAdd(operation, index);
        } else if (operation.kind === "delete") {
          await this.planDelete(operation, index);
        } else {
          await this.planUpdate(operation, index);
        }
        if (instruction.reason) {
          instruction.status = "no-op";
        } else {
          instruction.status = "planned";
        }
      } catch (error) {
        if (operation.kind === "update") {
          const move = semanticMoveOperation(operation);
          const deadProof = move
            ? await this.deadMoveProof(index, operation.absolutePath, move.moveAbsolutePath)
            : await this.deadUpdateProof(index, operation.absolutePath);
          if (deadProof) {
            instruction.status = "dead";
            instruction.reason = instructionReason(
              "dead-dominated",
              deadProof.dominatingInstructions,
            );
            continue;
          }
        }
        for (const planned of this.instructions) {
          if (planned.status === "planned") planned.status = "not-run";
        }
        instruction.status = "failed";
        instruction.error = errorMessage(error);
        throw new SemanticPlanningError(
          instruction.error,
          this.instructions.map((item) => ({ ...item })),
          instruction.index,
          error,
        );
      }
    }
    return {
      actions: this.actions,
      exact: this.exact,
      instructions: this.instructions.map((instruction) => ({ ...instruction })),
    };
  }

  private newPhysicalFile(mode: number, linkCount = 1): PhysicalFileState {
    return { linkCount, mode: mode & 0o7777 };
  }

  private regularFileMode(entry: VirtualEntry): number | undefined {
    if (entry.kind !== "regular") return undefined;
    return entry.physical.mode;
  }

  private releasePhysicalLink(entry: VirtualEntry): void {
    if (entry.kind === "regular" && entry.physical.linkCount > 0) {
      entry.physical.linkCount -= 1;
    }
  }

  private markNoOp(
    instructionIndex: number,
    code: Exclude<ApplyPatchInstructionReasonCode, "dead-dominated" | "move-already-fulfilled">,
  ): void {
    requiredValue(
      this.instructions[instructionIndex],
      "The apply_patch instruction to mark as a no-op is missing.",
    ).reason = instructionReason(code);
  }

  private addNoChangeCheckpoint(instructionIndex: number): void {
    this.actions.push({ kind: "no-change", instructionIndex });
  }

  private async directoryIsCaseInsensitive(directory: string): Promise<boolean> {
    return directoryIsCaseInsensitive(directory, this.caseInsensitiveDirectories);
  }

  private async namesAlias(directory: string, left: string, right: string): Promise<boolean> {
    return namesAlias(directory, left, right, this.caseInsensitiveDirectories);
  }

  private pathIsDescendant(parent: string, candidate: string): boolean {
    const relation = relative(parent, candidate);
    return (
      relation !== "" &&
      relation !== ".." &&
      !relation.startsWith(`..${sep}`) &&
      !isAbsolute(relation)
    );
  }

  private invalidateDescendantPathIdentities(path: string, key: string): void {
    for (const [candidatePath, candidateKey] of this.pathKeys) {
      if (this.pathIsDescendant(path, candidatePath) || this.pathIsDescendant(key, candidateKey)) {
        this.pathKeys.delete(candidatePath);
        this.inspectionPaths.delete(candidatePath);
      }
    }
  }

  private async virtualParentTargetPath(
    path: string,
    resolving: Set<string>,
  ): Promise<string | undefined> {
    const root = parse(path).root;
    let parent = dirname(path);
    while (parent !== root) {
      const parentKey = await this.pathKey(parent, resolving);
      const entry = this.states.get(parentKey);
      if (entry?.kind === "symlink") {
        return resolve(entry.targetPath, relative(parent, path));
      }
      parent = dirname(parent);
    }
    return undefined;
  }

  private async pathKey(path: string, resolving = new Set<string>()): Promise<string> {
    const known = this.pathKeys.get(path);
    if (known) return known;
    if (resolving.has(path)) {
      throw new Error(`Failed to resolve ${path}: symlink cycle`);
    }
    resolving.add(path);
    try {
      const virtualTargetPath = await this.virtualParentTargetPath(path, resolving);
      if (virtualTargetPath) {
        const key = await this.pathKey(virtualTargetPath, resolving);
        this.pathKeys.set(path, key);
        this.inspectionPaths.set(
          path,
          this.inspectionPaths.get(virtualTargetPath) ?? virtualTargetPath,
        );
        return key;
      }
      const key = await this.filesystemPathKey(path);
      this.inspectionPaths.set(path, path);
      return key;
    } finally {
      resolving.delete(path);
    }
  }

  private async filesystemPathKey(path: string): Promise<string> {
    const parent = await realpathWithMissingTail(dirname(path));
    const requestedName = basename(path);
    let actualName = requestedName;
    try {
      const requestedMetadata = await lstat(path);
      const names = await readdir(parent);
      const exactName = names.find((name) => name === requestedName);
      if (exactName) {
        actualName = exactName;
      } else {
        for (const name of names) {
          const metadata = await lstat(join(parent, name));
          if (
            metadata.dev === requestedMetadata.dev &&
            metadata.ino === requestedMetadata.ino &&
            (await this.namesAlias(parent, name, requestedName))
          ) {
            actualName = name;
            break;
          }
        }
      }
      // oxlint-disable-next-line preserve-caught-error -- Filesystem spelling discovery is best-effort; known planner identities remain the authoritative fallback.
    } catch {
      for (const [knownPath, knownKey] of this.pathKeys) {
        const knownParent = await realpathWithMissingTail(dirname(knownPath));
        if (
          knownParent === parent &&
          (await this.namesAlias(parent, basename(knownPath), requestedName))
        ) {
          this.pathKeys.set(path, knownKey);
          this.inspectionPaths.set(path, this.inspectionPaths.get(knownPath) ?? path);
          return knownKey;
        }
      }
    }
    const key = join(parent, actualName);
    this.pathKeys.set(path, key);
    return key;
  }

  private async stateAt(path: string): Promise<VirtualEntry> {
    const key = await this.pathKey(path);
    const known = this.states.get(key);
    if (known) return known;
    const inspectionPath = this.inspectionPaths.get(path) ?? path;

    let result: VirtualEntry;
    try {
      const metadata = await lstat(inspectionPath);
      const entryFingerprint = fingerprint(metadata);
      if (metadata.isFile()) {
        const physicalKey = `${metadata.dev}:${metadata.ino}`;
        let file = this.physicalFiles.get(physicalKey);
        if (!file) {
          file = {
            content: {},
            physical: this.newPhysicalFile(metadata.mode, metadata.nlink),
          };
          this.physicalFiles.set(physicalKey, file);
        }
        result = {
          kind: "regular",
          entryName: basename(key),
          sourcePath: inspectionPath,
          fingerprint: entryFingerprint,
          content: file.content,
          physical: file.physical,
        };
      } else if (metadata.isSymbolicLink()) {
        const target = await readlink(inspectionPath);
        result = {
          kind: "symlink",
          entryPath: path,
          entryName: basename(key),
          fingerprint: entryFingerprint,
          target,
          targetPath: resolve(dirname(key), target),
          content: {},
        };
      } else if (metadata.isDirectory()) {
        result = { kind: "directory", fingerprint: entryFingerprint };
      } else {
        result = {
          kind: "unsupported",
          entryType: entryType(metadata),
        };
      }
    } catch (error) {
      if (!isNotFound(error)) {
        throw new Error(`Failed to inspect ${path}: ${errorMessage(error)}`, { cause: error });
      }
      result = ABSENT_ENTRY;
    }
    this.states.set(key, result);
    return result;
  }

  private async setState(path: string, entry: VirtualEntry): Promise<void> {
    const key = await this.pathKey(path);
    this.states.set(key, entry);
    this.invalidateDescendantPathIdentities(path, key);
  }

  private async sameEntryMoveEffect(
    sourcePath: string,
    destinationPath: string,
  ): Promise<"rename" | "satisfied"> {
    const [sourceParent, destinationParent] = await Promise.all([
      this.realParentOrLexical(sourcePath),
      this.realParentOrLexical(destinationPath),
    ]);
    return sourceParent === destinationParent &&
      dirname(sourcePath) === dirname(destinationPath) &&
      basename(sourcePath) !== basename(destinationPath)
      ? "rename"
      : "satisfied";
  }

  private async realParentOrLexical(path: string): Promise<string> {
    const parent = dirname(path);
    try {
      return await realpath(parent);
    } catch (cause) {
      if (isNotFound(cause)) return parent;
      throw new Error(`Failed to resolve parent directory ${parent}`, { cause });
    }
  }

  private virtualSpellingSatisfied(entryName: string, requestedPath: string): boolean {
    return entryName === basename(requestedPath);
  }

  private snapshot<T extends VirtualEntry>(entry: T): T {
    if (entry.kind !== "regular" && entry.kind !== "symlink") return { ...entry };
    const content: ContentCell = {};
    if (entry.content.value) content.value = entry.content.value;
    return {
      ...entry,
      content,
    };
  }

  private async readBytes(
    entry: Extract<VirtualEntry, { kind: "regular" | "symlink" }>,
    path: string,
    visitedSymlinks = new Set<string>(),
  ): Promise<Buffer> {
    if (entry.kind === "regular" && entry.content.value) return entry.content.value.bytes;
    try {
      if (entry.kind === "symlink") {
        const key = await this.pathKey(entry.entryPath);
        if (visitedSymlinks.has(key)) throw new Error("symlink cycle");
        visitedSymlinks.add(key);
        const target = await this.stateAt(entry.targetPath);
        if (target.kind !== "regular" && target.kind !== "symlink") {
          throw new Error(
            target.kind === "absent"
              ? "symlink target does not exist"
              : target.kind === "directory"
                ? "symlink target is a directory"
                : `symlink target is a ${target.entryType}`,
          );
        }
        const bytes = await this.readBytes(target, entry.targetPath, visitedSymlinks);
        entry.content = target.content;
        return bytes;
      }
      const bytes = await readFile(
        requiredValue(entry.sourcePath, "An opaque regular file has no source path."),
      );
      entry.content.value = { bytes };
      return bytes;
    } catch (error) {
      throw new Error(`Failed to read file to update ${path}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  private async readText(
    entry: Extract<VirtualEntry, { kind: "regular" | "symlink" }>,
    path: string,
  ): Promise<string> {
    if (entry.content.value?.text !== undefined) return entry.content.value.text;
    const bytes = await this.readBytes(entry, path);
    let text: string;
    try {
      text = UTF8_DECODER.decode(bytes);
    } catch (error) {
      throw new Error(`Failed to read file to update ${path}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    entry.content.value = { bytes, text };
    return text;
  }

  private async optionalText(
    entry: Extract<VirtualEntry, { kind: "regular" | "symlink" }>,
    path: string,
  ): Promise<string | undefined> {
    if (entry.content.value?.text !== undefined) return entry.content.value.text;
    try {
      const bytes = await this.readBytes(entry, path);
      const text = UTF8_DECODER.decode(bytes);
      entry.content.value = { bytes, text };
      return text;
      // oxlint-disable-next-line preserve-caught-error -- Previous content is optional result metadata; an unreadable or non-text entry must not block replacement.
    } catch {
      return undefined;
    }
  }

  private async ensureParents(targetPath: string): Promise<string[]> {
    const missing: string[] = [];
    const root = parse(targetPath).root;
    let parent = dirname(targetPath);
    while (parent !== root) {
      const entry = await this.stateAt(parent);
      if (entry.kind === "absent") {
        missing.push(parent);
        parent = dirname(parent);
        continue;
      }
      if (entry.kind === "directory") {
        break;
      }
      if (entry.kind === "symlink") {
        const resolved = await this.resolvedEntryTarget(entry.targetPath);
        if (resolved?.entry.kind === "directory") break;
      }
      throw new Error(`Cannot create ${targetPath}: parent path ${parent} is not a directory`);
    }

    const created = missing.toReversed();
    for (const path of created) await this.setState(path, { kind: "directory" });
    return created;
  }

  private async entryFilesystemDevice(path: string): Promise<number> {
    const root = parse(path).root;
    let parent = dirname(path);
    while (true) {
      const entry = await this.stateAt(parent);
      if (entry.kind === "directory" && entry.fingerprint) {
        return entry.fingerprint.device;
      }
      if (entry.kind === "symlink") {
        const resolved = await this.resolvedEntryTarget(entry.targetPath);
        if (resolved?.entry.kind === "directory") {
          if (resolved.entry.fingerprint) return resolved.entry.fingerprint.device;
          parent = resolved.path;
        }
      }
      if (parent === root) {
        throw new Error(`Cannot determine filesystem for ${path}`);
      }
      parent = dirname(parent);
    }
  }

  private operationRelatedPaths(operation: ResolvedOperation): string[] {
    if (operation.kind !== "update" || !operation.moveAbsolutePath) {
      return [operation.absolutePath];
    }
    return [operation.absolutePath, operation.moveAbsolutePath];
  }

  private async resolvedEntryTarget(
    path: string,
  ): Promise<{ path: string; entry: VirtualEntry } | undefined> {
    let targetPath = path;
    let target = await this.stateAt(targetPath);
    const visited = new Set<string>();
    while (target.kind === "symlink") {
      const key = await this.pathKey(target.entryPath);
      if (visited.has(key)) return undefined;
      visited.add(key);
      targetPath = target.targetPath;
      target = await this.stateAt(targetPath);
    }
    return { path: targetPath, entry: target };
  }

  private async operationObservesPhysicalEntry(
    operation: ResolvedOperation,
    affected: Extract<VirtualEntry, { kind: "regular" }>,
  ): Promise<boolean> {
    const sameEntry = (entry: VirtualEntry | undefined): boolean => {
      if (entry?.kind !== "regular") return false;
      return affected.physical === entry.physical;
    };
    if (operation.kind === "update" && !chunksAreIdentity(operation.chunks)) {
      const target = await this.resolvedEntryTarget(operation.absolutePath);
      return sameEntry(target?.entry);
    }
    if (operation.kind === "update" && chunksAreIdentity(operation.chunks)) {
      const move = semanticMoveOperation(operation);
      if (!move) return false;
      const source = await this.stateAt(operation.absolutePath);
      const destination = await this.stateAt(move.moveAbsolutePath);
      return [source, destination].some(sameEntry);
    }
    return false;
  }

  private async deadUpdateProof(
    index: number,
    targetPath: string,
  ): Promise<DeadOperationProof | undefined> {
    const target = await this.resolvedEntryTarget(targetPath);
    if (!target) return undefined;

    const targetKey = await this.pathKey(targetPath);
    if (target.entry.kind === "absent") {
      for (let futureIndex = index + 1; futureIndex < this.operations.length; futureIndex += 1) {
        const operation = this.operations[futureIndex];
        if (operation === undefined) {
          throw new Error(`Future apply_patch operation ${futureIndex + 1} is missing.`);
        }
        if (
          (operation.kind === "add" || operation.kind === "delete") &&
          (await this.pathKey(operation.absolutePath)) === targetKey
        ) {
          return { dominatingInstructions: [futureIndex + 1] };
        }
        if (
          operation.kind === "update" &&
          semanticMoveOperation(operation) === undefined &&
          chunksAreIdentity(operation.chunks)
        ) {
          continue;
        }
        if (
          (
            await Promise.all(
              this.operationRelatedPaths(operation).map(async (path) => {
                return (await this.pathKey(path)) === targetKey || pathIsRelated(path, targetPath);
              }),
            )
          ).some(Boolean)
        ) {
          return undefined;
        }
      }
      return undefined;
    }

    if (target.entry.kind !== "regular") return undefined;
    const affectedPhysical = target.entry.physical;
    const effectiveLinkCount = affectedPhysical.linkCount;
    const affectedKey = await this.pathKey(target.path);
    const removedEntryInstructions = new Map<string, number>();
    const samePhysicalFile = (
      entry: VirtualEntry,
    ): entry is Extract<VirtualEntry, { kind: "regular" }> => {
      if (entry.kind !== "regular") return false;
      return affectedPhysical === entry.physical;
    };
    type ProofEntryState = "absent" | "affected" | "other";
    const proofEntryStates = new Map<string, ProofEntryState>();
    const proofEntryAt = async (
      path: string,
    ): Promise<{
      key: string;
      state: ProofEntryState;
      entry?: Extract<VirtualEntry, { kind: "regular" }>;
    }> => {
      const key = await this.pathKey(path);
      const known = proofEntryStates.get(key);
      if (known) return { key, state: known };
      const entry = await this.stateAt(path);
      if (samePhysicalFile(entry)) return { key, state: "affected", entry };
      return { key, state: entry.kind === "absent" ? "absent" : "other" };
    };
    const completedProof = (): DeadOperationProof | undefined => {
      return removedEntryInstructions.size >= effectiveLinkCount
        ? { dominatingInstructions: [...removedEntryInstructions.values()] }
        : undefined;
    };
    for (let futureIndex = index + 1; futureIndex < this.operations.length; futureIndex += 1) {
      const operation = this.operations[futureIndex];
      if (operation === undefined) {
        throw new Error(`Future apply_patch operation ${futureIndex + 1} is missing.`);
      }
      if (
        operation.kind === "update" &&
        semanticMoveOperation(operation) === undefined &&
        chunksAreIdentity(operation.chunks)
      ) {
        continue;
      }
      if (operation.kind === "delete") {
        const deleted = await proofEntryAt(operation.absolutePath);
        if (deleted.state === "affected") {
          removedEntryInstructions.set(deleted.key, futureIndex + 1);
          const proof = completedProof();
          if (proof) return proof;
        }
        proofEntryStates.set(deleted.key, "absent");
        continue;
      }
      if (operation.kind === "add") {
        const replaced = await proofEntryAt(operation.absolutePath);
        if (replaced.state === "affected") {
          const entry = requiredValue(
            replaced.entry,
            "An affected proof entry has no filesystem entry.",
          );
          const addIsNoOp =
            buffersEqual(
              await this.readBytes(entry, operation.absolutePath),
              Buffer.from(operation.content, "utf8"),
            ) && this.virtualSpellingSatisfied(entry.entryName, operation.absolutePath);
          if (addIsNoOp) {
            // Whether this add replaces the entry would depend on the unknown update.
            return undefined;
          }
          removedEntryInstructions.set(replaced.key, futureIndex + 1);
        }
        proofEntryStates.set(replaced.key, "other");
        const proof = completedProof();
        if (proof) return proof;
        continue;
      }
      if (await this.operationObservesPhysicalEntry(operation, target.entry)) {
        return undefined;
      }
      if (
        (
          await Promise.all(
            this.operationRelatedPaths(operation).map(async (path) => {
              return (await this.pathKey(path)) === affectedKey || pathIsRelated(path, target.path);
            }),
          )
        ).some(Boolean)
      ) {
        return undefined;
      }
    }
    return undefined;
  }

  private async deadMoveProof(
    index: number,
    sourcePath: string,
    destinationPath: string,
  ): Promise<DeadOperationProof | undefined> {
    const source = await this.stateAt(sourcePath);
    if (source.kind !== "absent" && source.kind !== "regular" && source.kind !== "symlink") {
      return undefined;
    }
    const sourceKey = await this.pathKey(sourcePath);
    const destinationKey = await this.pathKey(destinationPath);
    let sourceDominated = source.kind === "absent";
    let destinationDominated = false;
    let destinationParentsReproduced = false;
    const dominatingInstructions = new Set<number>();
    const defaultFileMode = 0o666 & ~process.umask();
    const materializedMode = this.regularFileMode(source) ?? defaultFileMode;

    const destinationParent = await this.stateAt(dirname(destinationPath));
    const destination = await this.stateAt(destinationPath);
    const addResultMode = (entry: VirtualEntry): number | undefined => {
      if (entry.kind === "absent" || entry.kind === "symlink") return defaultFileMode;
      if (entry.kind === "regular") return this.regularFileMode(entry);
      return undefined;
    };
    const addDominates = async (
      entry: VirtualEntry,
      operation: Extract<ResolvedOperation, { kind: "add" }>,
      expectedMode: number,
    ): Promise<boolean> => {
      if (entry.kind === "regular") {
        if (
          buffersEqual(
            await this.readBytes(entry, operation.absolutePath),
            Buffer.from(operation.content, "utf8"),
          ) &&
          this.virtualSpellingSatisfied(entry.entryName, operation.absolutePath)
        ) {
          return false;
        }
      }
      return addResultMode(entry) === expectedMode;
    };
    if (destinationParent.kind === "directory") {
      destinationParentsReproduced = true;
    } else if (destinationParent.kind === "symlink") {
      destinationParentsReproduced =
        (await this.resolvedEntryTarget(destinationParent.targetPath))?.entry.kind === "directory";
    }

    for (let futureIndex = index + 1; futureIndex < this.operations.length; futureIndex += 1) {
      const operation = this.operations[futureIndex];
      if (operation === undefined) {
        throw new Error(`Future apply_patch operation ${futureIndex + 1} is missing.`);
      }
      const instructionNumber = futureIndex + 1;
      const operationPaths = this.operationRelatedPaths(operation);
      const operationKeys = await Promise.all(operationPaths.map((path) => this.pathKey(path)));
      const targetKey = operationKeys[0];
      if (targetKey === undefined) {
        throw new Error(`Apply-patch operation ${futureIndex + 1} has no target path key.`);
      }
      if (operation.kind === "add" || operation.kind === "delete") {
        if (
          targetKey === sourceKey &&
          (operation.kind === "delete" || (await addDominates(source, operation, defaultFileMode)))
        ) {
          sourceDominated = true;
          dominatingInstructions.add(instructionNumber);
        }
        if (targetKey === destinationKey) {
          if (
            operation.kind === "delete" ||
            (await addDominates(destination, operation, materializedMode))
          ) {
            destinationDominated = true;
            dominatingInstructions.add(instructionNumber);
          }
          if (operation.kind === "add") {
            destinationParentsReproduced = true;
            dominatingInstructions.add(instructionNumber);
          }
        }
        if (sourceDominated && destinationDominated && destinationParentsReproduced) {
          return { dominatingInstructions: [...dominatingInstructions] };
        }
        continue;
      }
      if (
        operation.kind === "update" &&
        semanticMoveOperation(operation) === undefined &&
        chunksAreIdentity(operation.chunks)
      ) {
        continue;
      }
      if (
        operationPaths.some((path, pathIndex) => {
          const key = operationKeys[pathIndex];
          return (
            (!sourceDominated && (key === sourceKey || pathIsRelated(path, sourcePath))) ||
            (!destinationDominated &&
              (key === destinationKey || pathIsRelated(path, destinationPath)))
          );
        })
      ) {
        return undefined;
      }
    }
    return sourceDominated && destinationDominated && destinationParentsReproduced
      ? { dominatingInstructions: [...dominatingInstructions] }
      : undefined;
  }

  private async planAdd(
    operation: Extract<ResolvedOperation, { kind: "add" }>,
    instructionIndex: number,
  ): Promise<void> {
    const target = await this.stateAt(operation.absolutePath);
    if (target.kind === "directory" || target.kind === "unsupported") {
      throw new Error(
        `Cannot add ${operation.absolutePath}: path is ${target.kind === "directory" ? "a directory" : `a ${target.entryType}`}`,
      );
    }
    const content = Buffer.from(operation.content, "utf8");
    if (target.kind === "regular") {
      try {
        if (
          buffersEqual(await this.readBytes(target, operation.absolutePath), content) &&
          target.entryName === basename(operation.absolutePath)
        ) {
          this.markNoOp(instructionIndex, "content-already-present");
          this.addNoChangeCheckpoint(instructionIndex);
          return;
        }
        // oxlint-disable-next-line preserve-caught-error -- This no-op probe is optional; execution can still replace the entry and records that the resulting details are inexact.
      } catch {
        this.exact = false;
      }
    }

    const parents =
      target.kind === "absent" ? await this.ensureParents(operation.absolutePath) : [];
    const overwrittenContent =
      target.kind === "regular" || target.kind === "symlink"
        ? await this.optionalText(target, operation.absolutePath)
        : undefined;
    const expectedTarget = this.snapshot(target);
    const change: Extract<AppliedPatchChange, { kind: "add" }> = {
      kind: "add",
      path: operation.path,
      content: operation.content,
      ...diffDetails("", operation.content),
    };
    if (overwrittenContent !== undefined) change.overwrittenContent = overwrittenContent;
    const mutation: Extract<PlannedMutation, { kind: "add" }> = {
      instructionIndex,
      kind: "add",
      operation,
      expectedTarget,
      createdParentPaths: parents,
      content,
      change,
    };
    this.actions.push(mutation);
    this.releasePhysicalLink(target);
    const resultingMode = this.regularFileMode(target) ?? 0o666 & ~process.umask();
    await this.setState(operation.absolutePath, {
      kind: "regular",
      entryName: basename(operation.absolutePath),
      physical: this.newPhysicalFile(resultingMode),
      content: {
        value: { bytes: content, text: operation.content },
      },
    });
  }

  private async planDelete(
    operation: Extract<ResolvedOperation, { kind: "delete" }>,
    index: number,
  ): Promise<void> {
    const target = await this.stateAt(operation.absolutePath);
    if (target.kind === "absent") {
      this.markNoOp(index, "path-already-absent");
      this.addNoChangeCheckpoint(index);
      return;
    }
    if (target.kind === "directory" || target.kind === "unsupported") {
      throw new Error(
        `Cannot delete ${operation.absolutePath}: path is ${target.kind === "directory" ? "a directory" : `a ${target.entryType}`}`,
      );
    }

    const content =
      target.kind === "regular"
        ? (target.content.value?.text ??
          (this.hasLaterTextEdit(index, operation.absolutePath)
            ? await this.optionalText(target, operation.absolutePath)
            : undefined))
        : undefined;
    const expectedTarget = this.snapshot(target);
    const change: Extract<AppliedPatchChange, { kind: "delete" }> = {
      kind: "delete",
      path: operation.path,
      entryType: target.kind === "regular" ? "regular-file" : "symlink",
      displayDiff: "",
      additions: 0,
      deletions: 0,
    };
    if (content !== undefined) {
      const details = diffDetails(content, "");
      change.content = content;
      change.displayDiff = details.displayDiff;
      change.additions = details.additions;
      change.deletions = details.deletions;
    }
    this.actions.push({
      instructionIndex: index,
      kind: "delete",
      operation,
      expectedTarget,
      change,
    });
    this.releasePhysicalLink(target);
    await this.setState(operation.absolutePath, ABSENT_ENTRY);
  }

  private hasLaterTextEdit(index: number, targetPath: string): boolean {
    for (const operation of this.operations.slice(index + 1)) {
      if (operation.absolutePath !== targetPath) {
        if (this.operationRelatedPaths(operation).some((path) => pathIsRelated(path, targetPath))) {
          return false;
        }
        continue;
      }
      if (operation.kind === "add") return true;
      if (operation.kind === "delete") return false;
      return !chunksAreIdentity(operation.chunks);
    }
    return false;
  }

  private async planUpdate(
    operation: ResolvedUpdateOperation,
    instructionIndex: number,
  ): Promise<void> {
    const identity = chunksAreIdentity(operation.chunks);
    if (identity) {
      if (resolvedUpdateHasMove(operation)) {
        const move = semanticMoveOperation(operation);
        if (move) {
          await this.planPureMove(move, instructionIndex);
        } else {
          await this.validatePureMoveChunks(operation, await this.stateAt(operation.absolutePath));
          this.markNoOp(instructionIndex, "same-entry-move");
          if (operation.chunks.length > 0) {
            this.addNoChangeCheckpoint(instructionIndex);
          }
        }
      } else {
        this.markNoOp(
          instructionIndex,
          operation.chunks.length === 0 ? "empty-update" : "identity-update",
        );
      }
      return;
    }

    const source = await this.stateAt(operation.absolutePath);
    if (source.kind !== "regular" && source.kind !== "symlink") {
      const description =
        source.kind === "absent"
          ? "path does not exist"
          : source.kind === "unsupported"
            ? `path is a ${source.entryType}`
            : "path is a directory";
      throw new Error(`Failed to read file to update ${operation.absolutePath}: ${description}`);
    }

    const oldContent = await this.readText(source, operation.absolutePath);
    const newContent = deriveNewContent(
      oldContent,
      operation.chunks,
      operation.absolutePath,
      this.signal,
    );
    const content = Buffer.from(newContent, "utf8");
    const semanticMove = semanticMoveOperation(operation);
    const sourceKey = await this.pathKey(operation.absolutePath);
    if (
      semanticMove === undefined &&
      buffersEqual(
        requiredValue(
          source.content.value,
          "The source content was not populated after reading it.",
        ).bytes,
        content,
      )
    ) {
      this.markNoOp(instructionIndex, "update-result-unchanged");
      this.addNoChangeCheckpoint(instructionIndex);
      return;
    }

    if (semanticMove === undefined) {
      const expectedSource = this.snapshot(source);
      const change: Extract<AppliedPatchChange, { kind: "update" }> = {
        kind: "update",
        path: operation.path,
        oldContent,
        newContent,
        ...diffDetails(oldContent, newContent),
      };
      this.actions.push({
        instructionIndex,
        kind: "text-update",
        moveMode: "none",
        operation,
        expectedSource,
        createdParentPaths: [],
        content,
        change,
      });
      source.content.value = { bytes: content, text: newContent };
      if (source.kind === "symlink") {
        await this.setState(operation.absolutePath, {
          ...source,
        });
      } else {
        const resultingEntry: Extract<VirtualEntry, { kind: "regular" }> = {
          kind: "regular",
          entryName: source.entryName,
          content: source.content,
          physical: source.physical,
        };
        await this.setState(operation.absolutePath, resultingEntry);
      }
      return;
    }

    const destinationPath = semanticMove.moveAbsolutePath;
    const moveTo = semanticMove.moveTo;
    const destinationKey = await this.pathKey(destinationPath);
    if (sourceKey === destinationKey) {
      const expectedSource = this.snapshot(source);
      const sameEntryMove = await this.sameEntryMoveEffect(operation.absolutePath, destinationPath);
      const change: Extract<AppliedPatchChange, { kind: "update" }> = {
        kind: "update",
        path: operation.path,
        moveTo,
        oldContent,
        newContent,
        ...diffDetails(oldContent, newContent),
      };
      const mutation: Extract<PlannedMutation, { kind: "text-update" }> = {
        instructionIndex,
        kind: "text-update",
        moveMode: "same-entry",
        operation: semanticMove,
        expectedSource,
        expectedDestination: expectedSource,
        createdParentPaths: [],
        content,
        sameEntryMove,
        change,
        provisionalChange: {
          kind: "update",
          path: operation.path,
          oldContent,
          newContent,
          ...diffDetails(oldContent, newContent),
        },
      };
      this.actions.push(mutation);
      this.releasePhysicalLink(source);
      const resultingMode = this.regularFileMode(source) ?? 0o666 & ~process.umask();
      const resultingEntry: Extract<VirtualEntry, { kind: "regular" }> = {
        kind: "regular",
        entryName: basename(destinationPath),
        physical: this.newPhysicalFile(resultingMode),
        content: {
          value: { bytes: content, text: newContent },
        },
      };
      await this.setState(destinationPath, resultingEntry);
      this.fulfilledMoves.set(sourceKey, {
        destinationKey,
        destinationEntry: resultingEntry,
        instruction: instructionIndex + 1,
      });
      return;
    }

    const destination = await this.stateAt(destinationPath);
    if (destination.kind === "directory" || destination.kind === "unsupported") {
      throw new Error(
        `Cannot move update to ${destinationPath}: destination is ${destination.kind === "directory" ? "a directory" : `a ${destination.entryType}`}`,
      );
    }
    const parents = destination.kind === "absent" ? await this.ensureParents(destinationPath) : [];
    const overwrittenMoveContent =
      destination.kind === "regular" || destination.kind === "symlink"
        ? await this.optionalText(destination, destinationPath)
        : undefined;
    const expectedSource = this.snapshot(source);
    const expectedDestination = this.snapshot(destination);
    const change: Extract<AppliedPatchChange, { kind: "update" }> = {
      kind: "update",
      path: operation.path,
      moveTo,
      oldContent,
      newContent,
      ...diffDetails(oldContent, newContent),
    };
    if (overwrittenMoveContent !== undefined) {
      change.overwrittenMoveContent = overwrittenMoveContent;
    }
    const provisionalChange: Extract<AppliedPatchChange, { kind: "add" }> = {
      kind: "add",
      path: moveTo,
      content: newContent,
      ...diffDetails("", newContent),
    };
    if (overwrittenMoveContent !== undefined) {
      provisionalChange.overwrittenContent = overwrittenMoveContent;
    }
    const mutation: Extract<PlannedMutation, { kind: "text-update" }> = {
      instructionIndex,
      kind: "text-update",
      moveMode: "destination",
      operation: semanticMove,
      expectedSource,
      expectedDestination,
      createdParentPaths: parents,
      content,
      change,
      provisionalChange,
    };
    this.actions.push(mutation);
    this.releasePhysicalLink(source);
    this.releasePhysicalLink(destination);
    await this.setState(operation.absolutePath, ABSENT_ENTRY);
    const resultingMode = this.regularFileMode(source) ?? 0o666 & ~process.umask();
    const resultingEntry: Extract<VirtualEntry, { kind: "regular" }> = {
      kind: "regular",
      entryName: basename(destinationPath),
      physical: this.newPhysicalFile(resultingMode),
      content: {
        value: { bytes: content, text: newContent },
      },
    };
    await this.setState(destinationPath, resultingEntry);
    this.fulfilledMoves.set(sourceKey, {
      destinationKey,
      destinationEntry: resultingEntry,
      instruction: instructionIndex + 1,
    });
  }

  private async planPureMove(
    operation: ResolvedMoveUpdateOperation,
    instructionIndex: number,
  ): Promise<void> {
    const destinationPath = operation.moveAbsolutePath;
    const moveTo = operation.moveTo;
    const sourceKey = await this.pathKey(operation.absolutePath);
    const destinationKey = await this.pathKey(destinationPath);
    const source = await this.stateAt(operation.absolutePath);
    if (sourceKey === destinationKey) {
      await this.validatePureMoveChunks(operation, source);
      if (operation.absolutePath === destinationPath) {
        this.markNoOp(instructionIndex, "same-entry-move");
        if (operation.chunks.length > 0) {
          this.addNoChangeCheckpoint(instructionIndex);
        }
        return;
      }
      if (
        (source.kind === "regular" || source.kind === "symlink") &&
        this.virtualSpellingSatisfied(source.entryName, destinationPath)
      ) {
        this.markNoOp(instructionIndex, "same-entry-move");
        this.addNoChangeCheckpoint(instructionIndex);
        return;
      }
      if ((await this.sameEntryMoveEffect(operation.absolutePath, destinationPath)) === "rename") {
        if (source.kind !== "regular" && source.kind !== "symlink") {
          throw new Error(
            `Failed to move ${operation.absolutePath}: source is ${source.kind === "directory" ? "a directory" : source.kind === "absent" ? "absent" : `a ${source.entryType}`}`,
          );
        }
        const expectedSource = this.snapshot(source);
        const change: Extract<AppliedPatchChange, { kind: "move" }> = {
          kind: "move",
          sourcePath: operation.path,
          destinationPath: moveTo,
          replacedDestination: false,
          entryType: expectedSource.kind === "regular" ? "regular-file" : "symlink",
          exact: true,
          displayDiff: "",
          additions: 0,
          deletions: 0,
        };
        this.actions.push({
          instructionIndex,
          kind: "move",
          operation,
          expectedSource,
          expectedDestination: this.snapshot(source),
          createdParentPaths: [],
          moveStrategy: "rename",
          change,
        });
        await this.setState(destinationPath, {
          ...source,
          ...(source.kind === "symlink" ? { entryPath: destinationPath } : {}),
          entryName: basename(destinationPath),
        });
        return;
      }
      this.markNoOp(instructionIndex, "same-entry-move");
      this.addNoChangeCheckpoint(instructionIndex);
      return;
    }

    if (source.kind === "absent") {
      const fulfilled = this.fulfilledMoves.get(sourceKey);
      const destination = await this.stateAt(destinationPath);
      if (
        fulfilled?.destinationKey === destinationKey &&
        (destination.kind === "regular" || destination.kind === "symlink") &&
        fulfilled.destinationEntry === destination
      ) {
        await this.validatePureMoveChunks(operation, destination);
        requiredValue(
          this.instructions[instructionIndex],
          "The fulfilled move instruction is missing.",
        ).reason = moveAlreadyFulfilledReason(fulfilled.instruction);
        this.addNoChangeCheckpoint(instructionIndex);
        return;
      }
      throw new Error(
        `Failed to move ${operation.absolutePath}: source does not exist, and no earlier instruction moved it to ${destinationPath}`,
      );
    }
    if (source.kind !== "regular" && source.kind !== "symlink") {
      throw new Error(
        `Failed to move ${operation.absolutePath}: source is ${source.kind === "directory" ? "a directory" : `a ${source.entryType}`}`,
      );
    }
    await this.validatePureMoveChunks(operation, source);

    const expectedDestination = await this.stateAt(destinationPath);
    if (expectedDestination.kind === "directory" || expectedDestination.kind === "unsupported") {
      throw new Error(
        `Failed to move to ${destinationPath}: destination is ${expectedDestination.kind === "directory" ? "a directory" : `a ${expectedDestination.entryType}`}`,
      );
    }
    const parents =
      expectedDestination.kind === "absent" ? await this.ensureParents(destinationPath) : [];
    const [sourceDevice, destinationDevice] = await Promise.all([
      source.fingerprint?.device ?? this.entryFilesystemDevice(operation.absolutePath),
      this.entryFilesystemDevice(destinationPath),
    ]);
    const detectedMoveStrategy = sourceDevice === destinationDevice ? "rename" : "copy-unlink";
    const moveStrategy = this.selectMoveStrategy
      ? await this.selectMoveStrategy(operation.absolutePath, destinationPath, detectedMoveStrategy)
      : detectedMoveStrategy;
    const replacedDestination = expectedDestination.kind !== "absent";
    const expectedSource = this.snapshot(source);
    const destinationSnapshot = this.snapshot(expectedDestination);
    const change: Extract<AppliedPatchChange, { kind: "move" }> = {
      kind: "move",
      sourcePath: operation.path,
      destinationPath: moveTo,
      replacedDestination,
      entryType: expectedSource.kind === "regular" ? "regular-file" : "symlink",
      exact: true,
      displayDiff: "",
      additions: 0,
      deletions: 0,
    };
    this.actions.push({
      instructionIndex,
      kind: "move",
      operation,
      expectedSource,
      expectedDestination: destinationSnapshot,
      createdParentPaths: parents,
      moveStrategy,
      change,
    });
    this.releasePhysicalLink(expectedDestination);
    if (moveStrategy === "copy-unlink") this.releasePhysicalLink(source);
    await this.setState(operation.absolutePath, ABSENT_ENTRY);
    let resultingEntry: Extract<VirtualEntry, { kind: "regular" | "symlink" }>;
    if (moveStrategy === "copy-unlink" && source.kind === "regular") {
      const content: ContentCell = {};
      if (source.content.value) content.value = source.content.value;
      resultingEntry = {
        kind: "regular",
        entryName: basename(destinationPath),
        content,
        physical: this.newPhysicalFile(this.regularFileMode(source) ?? 0o666 & ~process.umask()),
      };
      if (!content.value) {
        resultingEntry.sourcePath = requiredValue(
          source.sourcePath,
          "An opaque copied regular file has no source path.",
        );
      }
    } else if (source.kind === "symlink") {
      resultingEntry = {
        kind: "symlink",
        entryPath: destinationPath,
        entryName: basename(destinationPath),
        target: source.target,
        targetPath: resolve(dirname(destinationKey), source.target),
        content: {},
      };
      if (moveStrategy === "rename" && source.fingerprint) {
        resultingEntry.fingerprint = source.fingerprint;
      }
    } else {
      resultingEntry = {
        ...source,
        entryName: basename(destinationPath),
      };
    }
    await this.setState(destinationPath, resultingEntry);
    this.fulfilledMoves.set(sourceKey, {
      destinationKey,
      destinationEntry: resultingEntry,
      instruction: instructionIndex + 1,
    });
  }

  private async validatePureMoveChunks(
    operation: ResolvedMoveUpdateOperation,
    source: VirtualEntry,
  ): Promise<void> {
    if (operation.chunks.length === 0) return;
    if (source.kind !== "regular" && source.kind !== "symlink") {
      const description =
        source.kind === "absent"
          ? "path does not exist"
          : source.kind === "unsupported"
            ? `path is a ${source.entryType}`
            : "path is a directory";
      throw new Error(`Failed to read file to update ${operation.absolutePath}: ${description}`);
    }
    const oldContent = await this.readText(source, operation.absolutePath);
    deriveNewContent(oldContent, operation.chunks, operation.absolutePath, this.signal);
    // Identity chunks constrain eligibility only; the pure move retains the
    // original entry and bytes even when a non-exact official tier matched.
  }
}
