import { lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
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
import { requestedSpellingExists } from "./apply-patch-engine-filesystem-mutations.ts";
import {
  ABSENT_ENTRY,
  UTF8_DECODER,
  buffersEqual,
  entryType,
  fingerprint,
  samePhysicalEntry,
  type ContentCell,
  type ParentPlan,
  type PlannedEntryMutation,
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
  private readonly mutations: PlannedMutation[] = [];
  private readonly fulfilledMoves = new Map<
    string,
    { destinationKey: string; destinationEntryId: string; instruction: number }
  >();
  private nextEntryId = 0;
  private nextPhysicalId = 0;
  private exact = true;
  private readonly operations: readonly ResolvedOperation[];
  private readonly instructions: ApplyPatchInstructionDetails[];
  private readonly signal: AbortSignal | undefined;
  private readonly selectMoveStrategy: ApplyPatchExecutionHooks["selectMoveStrategy"] | undefined;
  private readonly pathKeys = new Map<string, string>();
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
      const mutationCount = this.mutations.length;
      try {
        throwIfAborted(this.signal);
        if (operation.kind === "add") {
          await this.planAdd(operation, index);
        } else if (operation.kind === "delete") {
          await this.planDelete(operation, index);
        } else {
          await this.planUpdate(operation, index);
        }
        if (this.mutations.length > mutationCount) {
          instruction.status = "planned";
        } else {
          if (!instruction.reason) {
            throw new Error(`Instruction ${instruction.index} has no recorded no-op reason`);
          }
          instruction.status = "no-op";
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
      mutations: this.mutations,
      exact: this.exact,
      instructions: this.instructions.map((instruction) => ({ ...instruction })),
    };
  }

  private newEntryId(): string {
    this.nextEntryId += 1;
    return `planned-entry-${this.nextEntryId}`;
  }

  private newPhysicalFile(linkCount = 1): PhysicalFileState {
    this.nextPhysicalId += 1;
    return {
      id: `planned-physical-${this.nextPhysicalId}`,
      linkCount,
    };
  }

  private releasePhysicalLink(entry: VirtualEntry): void {
    if (entry.kind === "regular" && entry.physical && entry.physical.linkCount > 0) {
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

  private async directoryIsCaseInsensitive(directory: string): Promise<boolean> {
    return directoryIsCaseInsensitive(directory, this.caseInsensitiveDirectories);
  }

  private async namesAlias(directory: string, left: string, right: string): Promise<boolean> {
    return namesAlias(directory, left, right, this.caseInsensitiveDirectories);
  }

  private async pathKey(path: string): Promise<string> {
    const known = this.pathKeys.get(path);
    if (known) return known;
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
    } catch {
      for (const [knownPath, knownKey] of this.pathKeys) {
        const knownParent = await realpathWithMissingTail(dirname(knownPath));
        if (
          knownParent === parent &&
          (await this.namesAlias(parent, basename(knownPath), requestedName))
        ) {
          this.pathKeys.set(path, knownKey);
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

    let result: VirtualEntry;
    try {
      const metadata = await lstat(path);
      const entryFingerprint = fingerprint(metadata);
      if (metadata.isFile()) {
        const physicalKey = `${metadata.dev}:${metadata.ino}`;
        let file = this.physicalFiles.get(physicalKey);
        if (!file) {
          file = {
            content: { planned: false },
            physical: this.newPhysicalFile(metadata.nlink),
          };
          this.physicalFiles.set(physicalKey, file);
        }
        result = {
          kind: "regular",
          id: this.newEntryId(),
          entryPath: path,
          sourcePath: path,
          fingerprint: entryFingerprint,
          content: file.content,
          physical: file.physical,
        };
      } else if (metadata.isSymbolicLink()) {
        const target = await readlink(path);
        result = {
          kind: "symlink",
          id: this.newEntryId(),
          entryPath: path,
          sourcePath: path,
          fingerprint: entryFingerprint,
          target,
          targetPath: resolve(dirname(path), target),
          content: { planned: false },
        };
      } else if (metadata.isDirectory()) {
        result = { kind: "directory", fingerprint: entryFingerprint };
      } else {
        result = {
          kind: "unsupported",
          entryType: entryType(metadata),
          fingerprint: entryFingerprint,
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
    this.states.set(await this.pathKey(path), entry);
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

  private virtualSpellingSatisfied(entryPath: string, requestedPath: string): boolean {
    return basename(entryPath) === basename(requestedPath);
  }

  private snapshot<T extends VirtualEntry>(entry: T): T {
    if (entry.kind !== "regular" && entry.kind !== "symlink") return { ...entry };
    const content: ContentCell = { planned: entry.content.planned };
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
      const bytes = await readFile(entry.sourcePath ?? path);
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
    } catch {
      return undefined;
    }
  }

  private async ensureParents(targetPath: string): Promise<ParentPlan> {
    const missing: string[] = [];
    const expectations: ParentPlan["expectations"] = [];
    const root = parse(targetPath).root;
    let parent = dirname(targetPath);
    while (parent !== root) {
      const entry = await this.stateAt(parent);
      if (entry.kind === "absent") {
        expectations.push({ path: parent, kind: "absent" });
        missing.push(parent);
        parent = dirname(parent);
        continue;
      }
      if (entry.kind === "directory") {
        expectations.push({ path: parent, kind: "directory" });
        break;
      }
      if (entry.kind === "symlink") {
        try {
          const metadata = await stat(entry.sourcePath ?? parent);
          if (metadata.isDirectory()) {
            expectations.push({ path: parent, kind: "directory-symlink" });
            break;
          }
        } catch (cause) {
          if (!isNotFound(cause)) {
            throw new Error(`Failed to inspect parent path ${parent}`, { cause });
          }
        }
      }
      throw new Error(`Cannot create ${targetPath}: parent path ${parent} is not a directory`);
    }

    const created = missing.toReversed();
    for (const path of created) await this.setState(path, { kind: "directory" });
    return { createdPaths: created, expectations };
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
        try {
          const metadata = await stat(entry.sourcePath ?? parent);
          if (metadata.isDirectory()) return metadata.dev;
        } catch (cause) {
          if (!isNotFound(cause)) {
            throw new Error(`Failed to inspect parent path ${parent}`, { cause });
          }
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

  private async resolvedTextTarget(
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
      if (affected.physical && entry.physical) {
        return affected.physical.id === entry.physical.id;
      }
      return (
        affected.fingerprint !== undefined &&
        entry.fingerprint !== undefined &&
        samePhysicalEntry(affected.fingerprint, entry.fingerprint)
      );
    };
    if (operation.kind === "update" && !chunksAreIdentity(operation.chunks)) {
      const target = await this.resolvedTextTarget(operation.absolutePath);
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
    const target = await this.resolvedTextTarget(targetPath);
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
    const affectedFingerprint = target.entry.fingerprint;
    const affectedPhysical = target.entry.physical;
    if (!affectedFingerprint && !affectedPhysical) return undefined;
    const effectiveLinkCount = affectedPhysical?.linkCount ?? affectedFingerprint?.linkCount;
    if (effectiveLinkCount === undefined) return undefined;
    const affectedKey = await this.pathKey(target.path);
    const removedEntryInstructions = new Map<string, number>();
    const samePhysicalFile = (
      entry: VirtualEntry,
    ): entry is Extract<VirtualEntry, { kind: "regular" }> => {
      if (entry.kind !== "regular") return false;
      if (affectedPhysical && entry.physical && affectedPhysical.id === entry.physical.id) {
        return true;
      }
      return (
        affectedFingerprint !== undefined &&
        entry.fingerprint !== undefined &&
        samePhysicalEntry(entry.fingerprint, affectedFingerprint)
      );
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
            ) && this.virtualSpellingSatisfied(entry.entryPath, operation.absolutePath);
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
    const materializedMode =
      source.kind === "regular" && source.fingerprint
        ? source.fingerprint.mode & 0o7777
        : defaultFileMode;

    const destinationParent = await this.stateAt(dirname(destinationPath));
    const destination = await this.stateAt(destinationPath);
    const addResultMode = (entry: VirtualEntry): number | undefined => {
      if (entry.kind === "absent" || entry.kind === "symlink") return defaultFileMode;
      if (entry.kind === "regular" && entry.fingerprint) {
        return entry.fingerprint.mode & 0o7777;
      }
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
          this.virtualSpellingSatisfied(entry.entryPath, operation.absolutePath)
        ) {
          return false;
        }
      }
      return addResultMode(entry) === expectedMode;
    };
    if (destinationParent.kind === "directory") {
      destinationParentsReproduced = true;
    } else if (destinationParent.kind === "symlink") {
      try {
        destinationParentsReproduced = (await stat(destinationParent.entryPath)).isDirectory();
      } catch {
        return undefined;
      }
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
          (await requestedSpellingExists(operation.absolutePath))
        ) {
          this.markNoOp(instructionIndex, "content-already-present");
          return;
        }
      } catch {
        this.exact = false;
      }
    }

    const parents =
      target.kind === "absent"
        ? await this.ensureParents(operation.absolutePath)
        : { createdPaths: [], expectations: [] };
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
    const targetKey = await this.pathKey(operation.absolutePath);
    const entryMutation: PlannedEntryMutation = {
      path: operation.absolutePath,
      key: targetKey,
      kind: "regular",
    };
    if ((target.kind === "regular" || target.kind === "symlink") && target.fingerprint) {
      entryMutation.releasedFingerprint = target.fingerprint;
    }
    const mutation: Extract<PlannedMutation, { kind: "add" }> = {
      instructionIndex,
      kind: "add",
      operation,
      expectedTarget,
      parents,
      content,
      targetKey,
      entryMutations: [entryMutation],
      change,
    };
    if (target.kind === "regular" && target.fingerprint) {
      mutation.replacementMode = target.fingerprint.mode;
    }
    this.mutations.push(mutation);
    this.releasePhysicalLink(target);
    await this.setState(operation.absolutePath, {
      kind: "regular",
      id: this.newEntryId(),
      entryPath: operation.absolutePath,
      physical: this.newPhysicalFile(),
      content: {
        value: { bytes: content, text: operation.content },
        planned: true,
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
    const targetKey = await this.pathKey(operation.absolutePath);
    const entryMutation: PlannedEntryMutation = {
      path: operation.absolutePath,
      key: targetKey,
      kind: "absent",
    };
    if (target.fingerprint) entryMutation.releasedFingerprint = target.fingerprint;
    this.mutations.push({
      instructionIndex: index,
      kind: "delete",
      operation,
      expectedTarget,
      targetKey,
      entryMutations: [entryMutation],
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
      return;
    }

    if (semanticMove === undefined) {
      const expectedSource = this.snapshot(source);
      expectedSource.content.planned = true;
      const change: Extract<AppliedPatchChange, { kind: "update" }> = {
        kind: "update",
        path: operation.path,
        oldContent,
        newContent,
        ...diffDetails(oldContent, newContent),
      };
      this.mutations.push({
        instructionIndex,
        kind: "text-update",
        moveMode: "none",
        operation,
        expectedSource,
        parents: { createdPaths: [], expectations: [] },
        content,
        sourceKey,
        entryMutations: [],
        change,
      });
      source.content.value = { bytes: content, text: newContent };
      source.content.planned = true;
      if (source.kind === "symlink") {
        await this.setState(operation.absolutePath, {
          ...source,
        });
      } else {
        const resultingEntry: Extract<VirtualEntry, { kind: "regular" }> = {
          kind: "regular",
          id: this.newEntryId(),
          entryPath: operation.absolutePath,
          content: source.content,
        };
        if (source.fingerprint?.linkCount !== 1 && source.sourcePath !== undefined) {
          resultingEntry.sourcePath = source.sourcePath;
        }
        if (source.physical) resultingEntry.physical = source.physical;
        await this.setState(operation.absolutePath, resultingEntry);
      }
      return;
    }

    const destinationPath = semanticMove.moveAbsolutePath;
    const moveTo = semanticMove.moveTo;
    const destinationKey = await this.pathKey(destinationPath);
    if (sourceKey === destinationKey) {
      const expectedSource = this.snapshot(source);
      expectedSource.content.planned = true;
      const sameEntryMove = await this.sameEntryMoveEffect(operation.absolutePath, destinationPath);
      const change: Extract<AppliedPatchChange, { kind: "update" }> = {
        kind: "update",
        path: operation.path,
        moveTo,
        oldContent,
        newContent,
        ...diffDetails(oldContent, newContent),
      };
      const entryMutation: PlannedEntryMutation = {
        path: destinationPath,
        key: destinationKey,
        kind: "regular",
      };
      if (source.fingerprint) entryMutation.releasedFingerprint = source.fingerprint;
      const mutation: Extract<PlannedMutation, { kind: "text-update" }> = {
        instructionIndex,
        kind: "text-update",
        moveMode: "same-entry",
        operation: semanticMove,
        expectedSource,
        expectedDestination: expectedSource,
        parents: { createdPaths: [], expectations: [] },
        content,
        sourceKey,
        destinationKey,
        sameEntryMove,
        entryMutations: [entryMutation],
        change,
        provisionalChange: {
          kind: "update",
          path: operation.path,
          oldContent,
          newContent,
          ...diffDetails(oldContent, newContent),
        },
      };
      if (source.kind === "regular" && source.fingerprint) {
        mutation.replacementMode = source.fingerprint.mode;
      }
      this.mutations.push(mutation);
      this.releasePhysicalLink(source);
      const resultingEntry: Extract<VirtualEntry, { kind: "regular" }> = {
        kind: "regular",
        id: this.newEntryId(),
        entryPath: destinationPath,
        physical: this.newPhysicalFile(),
        content: {
          value: { bytes: content, text: newContent },
          planned: true,
        },
      };
      await this.setState(destinationPath, resultingEntry);
      this.fulfilledMoves.set(sourceKey, {
        destinationKey,
        destinationEntryId: resultingEntry.id,
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
    const parents =
      destination.kind === "absent"
        ? await this.ensureParents(destinationPath)
        : { createdPaths: [], expectations: [] };
    const overwrittenMoveContent =
      destination.kind === "regular" || destination.kind === "symlink"
        ? await this.optionalText(destination, destinationPath)
        : undefined;
    const expectedSource = this.snapshot(source);
    expectedSource.content.planned = true;
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
    const sourceEntryMutation: PlannedEntryMutation = {
      path: operation.absolutePath,
      key: sourceKey,
      kind: "absent",
    };
    if (source.fingerprint) sourceEntryMutation.releasedFingerprint = source.fingerprint;
    const destinationEntryMutation: PlannedEntryMutation = {
      path: destinationPath,
      key: destinationKey,
      kind: "regular",
    };
    if (
      (destination.kind === "regular" || destination.kind === "symlink") &&
      destination.fingerprint
    ) {
      destinationEntryMutation.releasedFingerprint = destination.fingerprint;
    }
    const mutation: Extract<PlannedMutation, { kind: "text-update" }> = {
      instructionIndex,
      kind: "text-update",
      moveMode: "destination",
      operation: semanticMove,
      expectedSource,
      expectedDestination,
      parents,
      content,
      sourceKey,
      destinationKey,
      entryMutations: [sourceEntryMutation, destinationEntryMutation],
      change,
      provisionalChange,
    };
    if (source.kind === "regular" && source.fingerprint) {
      mutation.replacementMode = source.fingerprint.mode;
    }
    this.mutations.push(mutation);
    this.releasePhysicalLink(source);
    this.releasePhysicalLink(destination);
    await this.setState(operation.absolutePath, ABSENT_ENTRY);
    const resultingEntry: Extract<VirtualEntry, { kind: "regular" }> = {
      kind: "regular",
      id: this.newEntryId(),
      entryPath: destinationPath,
      physical: this.newPhysicalFile(),
      content: {
        value: { bytes: content, text: newContent },
        planned: true,
      },
    };
    await this.setState(destinationPath, resultingEntry);
    this.fulfilledMoves.set(sourceKey, {
      destinationKey,
      destinationEntryId: resultingEntry.id,
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
        return;
      }
      if (
        (source.kind === "regular" || source.kind === "symlink") &&
        this.virtualSpellingSatisfied(source.entryPath, destinationPath)
      ) {
        this.markNoOp(instructionIndex, "same-entry-move");
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
        this.mutations.push({
          instructionIndex,
          kind: "move",
          operation,
          expectedSource,
          expectedDestination: this.snapshot(source),
          parents: { createdPaths: [], expectations: [] },
          sourceKey,
          destinationKey,
          moveStrategy: "rename",
          entryMutations: [
            {
              path: destinationPath,
              key: destinationKey,
              kind: expectedSource.kind,
            },
          ],
          change,
        });
        await this.setState(destinationPath, { ...source, entryPath: destinationPath });
        return;
      }
      this.markNoOp(instructionIndex, "same-entry-move");
      return;
    }

    if (source.kind === "absent") {
      const fulfilled = this.fulfilledMoves.get(sourceKey);
      const destination = await this.stateAt(destinationPath);
      if (
        fulfilled?.destinationKey === destinationKey &&
        (destination.kind === "regular" || destination.kind === "symlink") &&
        fulfilled.destinationEntryId === destination.id
      ) {
        await this.validatePureMoveChunks(operation, destination);
        requiredValue(
          this.instructions[instructionIndex],
          "The fulfilled move instruction is missing.",
        ).reason = moveAlreadyFulfilledReason(fulfilled.instruction);
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
      expectedDestination.kind === "absent"
        ? await this.ensureParents(destinationPath)
        : { createdPaths: [], expectations: [] };
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
    const sourceEntryMutation: PlannedEntryMutation = {
      path: operation.absolutePath,
      key: sourceKey,
      kind: "absent",
    };
    if (source.fingerprint) sourceEntryMutation.releasedFingerprint = source.fingerprint;
    const destinationEntryMutation: PlannedEntryMutation = {
      path: destinationPath,
      key: destinationKey,
      kind: expectedSource.kind === "regular" ? "regular" : "symlink",
    };
    if (
      (expectedDestination.kind === "regular" || expectedDestination.kind === "symlink") &&
      expectedDestination.fingerprint
    ) {
      destinationEntryMutation.releasedFingerprint = expectedDestination.fingerprint;
    }
    this.mutations.push({
      instructionIndex,
      kind: "move",
      operation,
      expectedSource,
      expectedDestination: destinationSnapshot,
      parents,
      sourceKey,
      destinationKey,
      moveStrategy,
      entryMutations: [sourceEntryMutation, destinationEntryMutation],
      change,
    });
    this.releasePhysicalLink(expectedDestination);
    if (moveStrategy === "copy-unlink") this.releasePhysicalLink(source);
    await this.setState(operation.absolutePath, ABSENT_ENTRY);
    let resultingEntry: Extract<VirtualEntry, { kind: "regular" | "symlink" }>;
    if (moveStrategy === "copy-unlink" && source.kind === "regular") {
      const content: ContentCell = { planned: source.content.planned };
      if (source.content.value) content.value = source.content.value;
      resultingEntry = {
        kind: "regular",
        id: this.newEntryId(),
        entryPath: destinationPath,
        sourcePath: source.sourcePath ?? source.entryPath,
        content,
        physical: this.newPhysicalFile(),
      };
    } else if (moveStrategy === "copy-unlink" && source.kind === "symlink") {
      resultingEntry = {
        kind: "symlink",
        id: this.newEntryId(),
        entryPath: destinationPath,
        target: source.target,
        targetPath: resolve(dirname(destinationPath), source.target),
        content: { planned: false },
      };
    } else if (source.kind === "symlink") {
      resultingEntry = {
        kind: "symlink",
        id: source.id,
        entryPath: destinationPath,
        target: source.target,
        targetPath: resolve(dirname(destinationPath), source.target),
        content: { planned: false },
      };
      if (source.fingerprint) resultingEntry.fingerprint = source.fingerprint;
    } else {
      resultingEntry = { ...source, entryPath: destinationPath };
    }
    await this.setState(destinationPath, resultingEntry);
    this.fulfilledMoves.set(sourceKey, {
      destinationKey,
      destinationEntryId: resultingEntry.id,
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
    source.content.planned = true;
  }
}
