import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";

const TOKEN_BYTES = 4;

export type CommandOutputDetails = {
  truncation?: TruncationResult;
  fullOutputPath?: string;
  chunkId?: string;
  exitCode?: number;
  sessionId?: number;
  wallTimeSeconds?: number;
  originalTokenCount?: number;
};

export type CommandOutputSnapshot = {
  text: string;
  details: CommandOutputDetails;
  originalTokenCount: number;
};

export class RecentCommandOutputBuffer {
  private readonly decoder = new TextDecoder();
  private text = "";
  private textBytes = 0;
  private lineBreaks = 0;
  private finished = false;

  append(data: Buffer | string): void {
    if (this.finished) return;
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    this.appendText(this.decoder.decode(bytes, { stream: true }));
    if (this.textBytes > DEFAULT_MAX_BYTES * 2 || this.lineBreaks > DEFAULT_MAX_LINES * 2) {
      this.trim();
    }
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.appendText(this.decoder.decode());
    this.trim();
  }

  snapshot(): string {
    return this.truncatedText();
  }

  private truncatedText(): string {
    return truncateTail(this.text, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    }).content;
  }

  private appendText(text: string): void {
    this.text += text;
    this.textBytes += byteLength(text);
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
      this.lineBreaks++;
    }
  }

  private trim(): void {
    this.text = this.truncatedText();
    this.textBytes = byteLength(this.text);
    this.lineBreaks = 0;
    for (
      let index = this.text.indexOf("\n");
      index !== -1;
      index = this.text.indexOf("\n", index + 1)
    ) {
      this.lineBreaks++;
    }
  }
}

function tempFilePath(prefix: string): string {
  return join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}.log`);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function modelOutputByteLimit(maxOutputTokens: number | undefined): number {
  if (maxOutputTokens === undefined) return DEFAULT_MAX_BYTES;
  return Math.min(DEFAULT_MAX_BYTES, Math.max(0, maxOutputTokens * TOKEN_BYTES));
}

function truncationNotice(
  truncation: TruncationResult,
  fullOutputPath: string,
  lastLineBytes: number,
): string {
  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;
  if (truncation.lastLinePartial) {
    return `[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${formatSize(lastLineBytes)}). Full output: ${fullOutputPath}]`;
  }
  if (truncation.truncatedBy === "lines") {
    return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
  }
  return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(truncation.maxBytes)} limit). Full output: ${fullOutputPath}]`;
}

/**
 * Pi-style streaming command output: bounded tail memory, tail truncation for
 * the model, and a complete raw temp file when output crosses a visible limit.
 */
export class CommandOutputAccumulator {
  private readonly decoder = new TextDecoder();
  private readonly listeners = new Set<() => void>();
  private readonly rawChunks: Buffer[] = [];
  private readonly tempFilePrefix: string;
  private tailText = "";
  private tailBytes = 0;
  private tailStartsAtLineBoundary = true;
  private totalRawBytes = 0;
  private totalDecodedBytes = 0;
  private completedLines = 0;
  private totalLines = 0;
  private currentLineBytes = 0;
  private hasOpenLine = false;
  private finished = false;
  private tempFilePath: string | undefined;
  private tempFileStream: WriteStream | undefined;
  private tempFileError: Error | undefined;

  constructor(tempFilePrefix: string) {
    this.tempFilePrefix = tempFilePrefix;
  }

  append(data: Buffer | string): void {
    if (this.finished) return;
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    this.totalRawBytes += bytes.length;
    this.appendDecodedText(this.decoder.decode(bytes, { stream: true }));

    if (this.tempFileStream || this.shouldUseTempFile()) {
      this.ensureTempFile();
      this.tempFileStream?.write(bytes);
    } else if (bytes.length > 0) {
      this.rawChunks.push(Buffer.from(bytes));
    }

    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.appendDecodedText(this.decoder.decode());
    if (this.shouldUseTempFile()) this.ensureTempFile();
  }

  snapshot(
    options: { maxOutputTokens?: number; persistIfTruncated?: boolean } = {},
  ): CommandOutputSnapshot {
    const maxBytes = modelOutputByteLimit(options.maxOutputTokens);
    const truncation = truncateTail(this.snapshotText(), {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes,
    });
    const truncated = this.totalLines > DEFAULT_MAX_LINES || this.totalDecodedBytes > maxBytes;
    const effectiveTruncation: TruncationResult = {
      ...truncation,
      truncated,
      truncatedBy:
        truncated && truncation.truncatedBy === null
          ? this.totalDecodedBytes > maxBytes
            ? "bytes"
            : "lines"
          : truncation.truncatedBy,
      totalLines: this.totalLines,
      totalBytes: this.totalDecodedBytes,
      maxLines: DEFAULT_MAX_LINES,
      maxBytes,
    };

    if (options.persistIfTruncated && effectiveTruncation.truncated) {
      this.ensureTempFile();
    }

    const originalTokenCount = Math.ceil(this.totalDecodedBytes / TOKEN_BYTES);
    let text = effectiveTruncation.content;
    const details: CommandOutputDetails = { originalTokenCount };
    if (effectiveTruncation.truncated) {
      const fullOutputPath = this.tempFilePath;
      if (!fullOutputPath) {
        throw new Error("Truncated command output is missing its complete-output file.");
      }
      text = `${text}${text ? "\n\n" : ""}${truncationNotice(
        effectiveTruncation,
        fullOutputPath,
        this.currentLineBytes,
      )}`;
      details.truncation = effectiveTruncation;
      details.fullOutputPath = fullOutputPath;
    }

    return { text, details, originalTokenCount };
  }

  async close(): Promise<void> {
    this.finish();
    if (!this.tempFileStream) {
      if (this.tempFileError) throw this.tempFileError;
      return;
    }

    const stream = this.tempFileStream;
    this.tempFileStream = undefined;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        stream.off("finish", onFinish);
        reject(error);
      };
      const onFinish = (): void => {
        stream.off("error", onError);
        resolve();
      };
      stream.once("error", onError);
      stream.once("finish", onFinish);
      stream.end();
    });
    if (this.tempFileError) throw this.tempFileError;
  }

  private appendDecodedText(text: string): void {
    if (text.length === 0) return;
    const bytes = byteLength(text);
    this.totalDecodedBytes += bytes;
    this.tailText += text;
    this.tailBytes += bytes;
    if (this.tailBytes > DEFAULT_MAX_BYTES * 4) this.trimTail();

    let newlines = 0;
    let lastNewline = -1;
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
      newlines++;
      lastNewline = index;
    }
    if (newlines === 0) {
      this.currentLineBytes += bytes;
      this.hasOpenLine = true;
    } else {
      this.completedLines += newlines;
      const tail = text.slice(lastNewline + 1);
      this.currentLineBytes = byteLength(tail);
      this.hasOpenLine = tail.length > 0;
    }
    this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
  }

  private trimTail(): void {
    const maximum = DEFAULT_MAX_BYTES * 2;
    const buffer = Buffer.from(this.tailText, "utf8");
    if (buffer.length <= maximum) {
      this.tailBytes = buffer.length;
      return;
    }

    let start = buffer.length - maximum;
    while (start < buffer.length) {
      const byte = buffer[start];
      if (byte === undefined || (byte & 0xc0) !== 0x80) break;
      start++;
    }
    this.tailStartsAtLineBoundary =
      start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
    this.tailText = buffer.subarray(start).toString("utf8");
    this.tailBytes = byteLength(this.tailText);
  }

  private snapshotText(): string {
    if (this.tailStartsAtLineBoundary) return this.tailText;
    const firstNewline = this.tailText.indexOf("\n");
    return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
  }

  private shouldUseTempFile(): boolean {
    return (
      this.totalRawBytes > DEFAULT_MAX_BYTES ||
      this.totalDecodedBytes > DEFAULT_MAX_BYTES ||
      this.totalLines > DEFAULT_MAX_LINES
    );
  }

  private ensureTempFile(): void {
    if (this.tempFilePath) return;
    this.tempFilePath = tempFilePath(this.tempFilePrefix);
    const stream = createWriteStream(this.tempFilePath);
    stream.on("error", (error) => {
      this.tempFileError = error;
    });
    this.tempFileStream = stream;
    for (const chunk of this.rawChunks) stream.write(chunk);
    this.rawChunks.length = 0;
  }
}
