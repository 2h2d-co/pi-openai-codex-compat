import { lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import {
  deriveNewContent,
  FormatterMatchError,
  type FormatterMatchFailureDetails,
} from "../apply-patch-matcher.ts";
import type {
  AppliedPatchChange,
  ApplyPatchExecutionHooks,
  ApplyPatchInstructionDetails,
  ApplyPatchInstructionReasonCode,
  ResolvedOperation,
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
  updateHasSemanticMove,
} from "./apply-patch-engine-operation-semantics.ts";
import {
  directoryIsCaseInsensitive,
  namesAlias,
  realpathWithMissingTail,
} from "./apply-patch-engine-path-identity.ts";

export class SemanticPlanningError extends Error {
  readonly instructions: ApplyPatchInstructionDetails[];
  readonly failedInstruction: number;
  readonly matcher: FormatterMatchFailureDetails | undefined;

  constructor(
    message: string,
    instructions: ApplyPatchInstructionDetails[],
    failedInstruction: number,
    matcher?: FormatterMatchFailureDetails,
  ) {
    super(message);
    this.instructions = instructions;
    this.failedInstruction = failedInstruction;
    this.matcher = matcher;
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
      const instruction = this.instructions[index]!;
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
          const deadProof = !updateHasSemanticMove(operation)
            ? await this.deadUpdateProof(index, operation.absolutePath)
            : await this.deadMoveProof(index, operation.absolutePath, operation.moveAbsolutePath!);
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
        if (error instanceof FormatterMatchError) instruction.matcher = error.details;
        throw new SemanticPlanningError(
          instruction.error,
          this.instructions.map((item) => ({ ...item })),
          instruction.index,
          error instanceof FormatterMatchError ? error.details : undefined,
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
    this.instructions[instructionIndex]!.reason = instructionReason(code);
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
        throw new Error(`Failed to inspect ${path}: ${errorMessage(error)}`);
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
      realpath(dirname(sourcePath)).catch(() => dirname(sourcePath)),
      realpath(dirname(destinationPath)).catch(() => dirname(destinationPath)),
    ]);
    return sourceParent === destinationParent &&
      dirname(sourcePath) === dirname(destinationPath) &&
      basename(sourcePath) !== basename(destinationPath)
      ? "rename"
      : "satisfied";
  }

  private virtualSpellingSatisfied(entryPath: string, requestedPath: string): boolean {
    return basename(entryPath) === basename(requestedPath);
  }

  private snapshot<T extends VirtualEntry>(entry: T): T {
    if (entry.kind !== "regular" && entry.kind !== "symlink") return { ...entry };
    return {
      ...entry,
      content: {
        ...(entry.content.value ? { value: entry.content.value } : {}),
        planned: entry.content.planned,
      },
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
      throw new Error(`Failed to read file to update ${path}: ${errorMessage(error)}`);
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
      throw new Error(`Failed to read file to update ${path}: ${errorMessage(error)}`);
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
        } catch {}
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
        } catch {}
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
      if (!updateHasSemanticMove(operation)) return false;
      const source = await this.stateAt(operation.absolutePath);
      const destination = await this.stateAt(operation.moveAbsolutePath!);
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
        const operation = this.operations[futureIndex]!;
        if (
          (operation.kind === "add" || operation.kind === "delete") &&
          (await this.pathKey(operation.absolutePath)) === targetKey
        ) {
          return { dominatingInstructions: [futureIndex + 1] };
        }
        if (
          operation.kind === "update" &&
          !updateHasSemanticMove(operation) &&
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
    const effectiveLinkCount = affectedPhysical?.linkCount ?? affectedFingerprint!.linkCount;
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
      const operation = this.operations[futureIndex]!;
      if (
        operation.kind === "update" &&
        !updateHasSemanticMove(operation) &&
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
          const entry = replaced.entry!;
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
      const operation = this.operations[futureIndex]!;
      const instructionNumber = futureIndex + 1;
      const operationPaths = this.operationRelatedPaths(operation);
      const operationKeys = await Promise.all(operationPaths.map((path) => this.pathKey(path)));
      const targetKey = operationKeys[0]!;
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
        !updateHasSemanticMove(operation) &&
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
      ...(overwrittenContent !== undefined ? { overwrittenContent } : {}),
      ...diffDetails("", operation.content),
    };
    const targetKey = await this.pathKey(operation.absolutePath);
    this.mutations.push({
      instructionIndex,
      kind: "add",
      operation,
      expectedTarget,
      parents,
      content,
      ...(target.kind === "regular" && target.fingerprint
        ? { replacementMode: target.fingerprint.mode }
        : {}),
      targetKey,
      entryMutations: [
        {
          path: operation.absolutePath,
          key: targetKey,
          kind: "regular",
          ...((target.kind === "regular" || target.kind === "symlink") && target.fingerprint
            ? { releasedFingerprint: target.fingerprint }
            : {}),
        },
      ],
      change,
    });
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
      ...(content !== undefined ? { content } : {}),
      ...(content === undefined
        ? { displayDiff: "", additions: 0, deletions: 0 }
        : diffDetails(content, "")),
    };
    const targetKey = await this.pathKey(operation.absolutePath);
    this.mutations.push({
      instructionIndex: index,
      kind: "delete",
      operation,
      expectedTarget,
      targetKey,
      entryMutations: [
        {
          path: operation.absolutePath,
          key: targetKey,
          kind: "absent",
          ...((target.kind === "regular" || target.kind === "symlink") && target.fingerprint
            ? { releasedFingerprint: target.fingerprint }
            : {}),
        },
      ],
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
    operation: Extract<ResolvedOperation, { kind: "update" }>,
    instructionIndex: number,
  ): Promise<void> {
    const identity = chunksAreIdentity(operation.chunks);
    if (identity) {
      if (operation.moveAbsolutePath !== undefined) {
        if (updateHasSemanticMove(operation)) {
          await this.planPureMove(operation, instructionIndex);
        } else {
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
    const newContent = await deriveNewContent(
      oldContent,
      operation.chunks,
      operation.absolutePath,
      this.signal,
    );
    const content = Buffer.from(newContent, "utf8");
    const semanticMove = updateHasSemanticMove(operation);
    const sourceKey = await this.pathKey(operation.absolutePath);
    if (!semanticMove && buffersEqual(source.content.value!.bytes, content)) {
      this.markNoOp(instructionIndex, "update-result-unchanged");
      return;
    }

    if (!semanticMove) {
      const expectedSource = this.snapshot(source) as Extract<
        VirtualEntry,
        { kind: "regular" | "symlink" }
      >;
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
        await this.setState(operation.absolutePath, {
          kind: "regular",
          id: this.newEntryId(),
          entryPath: operation.absolutePath,
          ...(source.fingerprint?.linkCount === 1 ? {} : { sourcePath: source.sourcePath }),
          content: source.content,
          ...(source.physical ? { physical: source.physical } : {}),
        });
      }
      return;
    }

    const destinationPath = operation.moveAbsolutePath!;
    const destinationKey = await this.pathKey(destinationPath);
    if (sourceKey === destinationKey) {
      const expectedSource = this.snapshot(source) as Extract<
        VirtualEntry,
        { kind: "regular" | "symlink" }
      >;
      expectedSource.content.planned = true;
      const sameEntryMove = await this.sameEntryMoveEffect(operation.absolutePath, destinationPath);
      const change: Extract<AppliedPatchChange, { kind: "update" }> = {
        kind: "update",
        path: operation.path,
        moveTo: operation.moveTo!,
        oldContent,
        newContent,
        ...diffDetails(oldContent, newContent),
      };
      this.mutations.push({
        instructionIndex,
        kind: "text-update",
        operation,
        expectedSource,
        expectedDestination: expectedSource,
        parents: { createdPaths: [], expectations: [] },
        content,
        ...(source.kind === "regular" && source.fingerprint
          ? { replacementMode: source.fingerprint.mode }
          : {}),
        sourceKey,
        destinationKey,
        sameEntryMove,
        entryMutations: [
          {
            path: destinationPath,
            key: destinationKey,
            kind: "regular",
            ...(source.fingerprint ? { releasedFingerprint: source.fingerprint } : {}),
          },
        ],
        change,
        provisionalChange: {
          kind: "update",
          path: operation.path,
          oldContent,
          newContent,
          ...diffDetails(oldContent, newContent),
        },
      });
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
    const expectedSource = this.snapshot(source) as Extract<
      VirtualEntry,
      { kind: "regular" | "symlink" }
    >;
    expectedSource.content.planned = true;
    const expectedDestination = this.snapshot(destination);
    const change: Extract<AppliedPatchChange, { kind: "update" }> = {
      kind: "update",
      path: operation.path,
      moveTo: operation.moveTo!,
      oldContent,
      newContent,
      ...(overwrittenMoveContent !== undefined ? { overwrittenMoveContent } : {}),
      ...diffDetails(oldContent, newContent),
    };
    const provisionalChange: Extract<AppliedPatchChange, { kind: "add" }> = {
      kind: "add",
      path: operation.moveTo!,
      content: newContent,
      ...(overwrittenMoveContent !== undefined
        ? { overwrittenContent: overwrittenMoveContent }
        : {}),
      ...diffDetails("", newContent),
    };
    this.mutations.push({
      instructionIndex,
      kind: "text-update",
      operation,
      expectedSource,
      expectedDestination,
      parents,
      content,
      ...(source.kind === "regular" && source.fingerprint
        ? { replacementMode: source.fingerprint.mode }
        : {}),
      sourceKey,
      destinationKey,
      entryMutations: [
        {
          path: operation.absolutePath,
          key: sourceKey,
          kind: "absent",
          ...(source.fingerprint ? { releasedFingerprint: source.fingerprint } : {}),
        },
        {
          path: destinationPath,
          key: destinationKey,
          kind: "regular",
          ...((destination.kind === "regular" || destination.kind === "symlink") &&
          destination.fingerprint
            ? { releasedFingerprint: destination.fingerprint }
            : {}),
        },
      ],
      change,
      provisionalChange,
    });
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
    operation: Extract<ResolvedOperation, { kind: "update" }>,
    instructionIndex: number,
  ): Promise<void> {
    const destinationPath = operation.moveAbsolutePath!;
    const sourceKey = await this.pathKey(operation.absolutePath);
    const destinationKey = await this.pathKey(destinationPath);
    if (sourceKey === destinationKey) {
      if (operation.absolutePath === destinationPath) {
        this.markNoOp(instructionIndex, "same-entry-move");
        return;
      }
      const source = await this.stateAt(operation.absolutePath);
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
        const expectedSource = this.snapshot(source) as Extract<
          VirtualEntry,
          { kind: "regular" | "symlink" }
        >;
        const change: Extract<AppliedPatchChange, { kind: "move" }> = {
          kind: "move",
          sourcePath: operation.path,
          destinationPath: operation.moveTo!,
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

    const source = await this.stateAt(operation.absolutePath);
    if (source.kind === "absent") {
      const fulfilled = this.fulfilledMoves.get(sourceKey);
      const destination = await this.stateAt(destinationPath);
      if (
        fulfilled?.destinationKey === destinationKey &&
        (destination.kind === "regular" || destination.kind === "symlink") &&
        fulfilled.destinationEntryId === destination.id
      ) {
        this.instructions[instructionIndex]!.reason = moveAlreadyFulfilledReason(
          fulfilled.instruction,
        );
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
    const expectedSource = this.snapshot(source) as Extract<
      VirtualEntry,
      { kind: "regular" | "symlink" }
    >;
    const destinationSnapshot = this.snapshot(expectedDestination);
    const change: Extract<AppliedPatchChange, { kind: "move" }> = {
      kind: "move",
      sourcePath: operation.path,
      destinationPath: operation.moveTo!,
      replacedDestination,
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
      expectedDestination: destinationSnapshot,
      parents,
      sourceKey,
      destinationKey,
      moveStrategy,
      entryMutations: [
        {
          path: operation.absolutePath,
          key: sourceKey,
          kind: "absent",
          ...(source.fingerprint ? { releasedFingerprint: source.fingerprint } : {}),
        },
        {
          path: destinationPath,
          key: destinationKey,
          kind: expectedSource.kind === "regular" ? "regular" : "symlink",
          ...((expectedDestination.kind === "regular" || expectedDestination.kind === "symlink") &&
          expectedDestination.fingerprint
            ? { releasedFingerprint: expectedDestination.fingerprint }
            : {}),
        },
      ],
      change,
    });
    this.releasePhysicalLink(expectedDestination);
    if (moveStrategy === "copy-unlink") this.releasePhysicalLink(source);
    await this.setState(operation.absolutePath, ABSENT_ENTRY);
    let resultingEntry: Extract<VirtualEntry, { kind: "regular" | "symlink" }>;
    if (moveStrategy === "copy-unlink" && source.kind === "regular") {
      const content: ContentCell = {
        ...(source.content.value ? { value: source.content.value } : {}),
        planned: source.content.planned,
      };
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
        ...(source.fingerprint ? { fingerprint: source.fingerprint } : {}),
        target: source.target,
        targetPath: resolve(dirname(destinationPath), source.target),
        content: { planned: false },
      };
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
}
