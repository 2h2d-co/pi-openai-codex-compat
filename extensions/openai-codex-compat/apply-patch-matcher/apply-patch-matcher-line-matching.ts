export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("apply_patch was cancelled.");
}

export function isRustWhitespace(codePoint: number): boolean {
  return (
    (codePoint >= 0x0009 && codePoint <= 0x000d) ||
    codePoint === 0x0020 ||
    codePoint === 0x0085 ||
    codePoint === 0x00a0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

export function rustTrimStart(value: string): string {
  let index = 0;
  while (index < value.length && isRustWhitespace(value.charCodeAt(index))) index += 1;
  return value.slice(index);
}

export function rustTrimEnd(value: string): string {
  let index = value.length;
  while (index > 0 && isRustWhitespace(value.charCodeAt(index - 1))) index -= 1;
  return value.slice(0, index);
}

export function rustTrim(value: string): string {
  return rustTrimEnd(rustTrimStart(value));
}

export function normalizeFuzzyText(value: string): string {
  const replacements = new Map(
    Object.entries({
      "\u2010": "-",
      "\u2011": "-",
      "\u2012": "-",
      "\u2013": "-",
      "\u2014": "-",
      "\u2015": "-",
      "\u2212": "-",
      "\u2018": "'",
      "\u2019": "'",
      "\u201a": "'",
      "\u201b": "'",
      "\u201c": '"',
      "\u201d": '"',
      "\u201e": '"',
      "\u201f": '"',
      "\u00a0": " ",
      "\u2002": " ",
      "\u2003": " ",
      "\u2004": " ",
      "\u2005": " ",
      "\u2006": " ",
      "\u2007": " ",
      "\u2008": " ",
      "\u2009": " ",
      "\u200a": " ",
      "\u202f": " ",
      "\u205f": " ",
      "\u3000": " ",
    } as const),
  );
  return Array.from(rustTrim(value))
    .map((character) => replacements.get(character) ?? character)
    .join("");
}

function sequenceMatches(
  lines: readonly string[],
  pattern: readonly string[],
  index: number,
  normalize: (value: string) => string,
): boolean {
  if (index + pattern.length > lines.length) return false;
  return pattern.every((expected, offset) => {
    const actual = lines[index + offset];
    return actual !== undefined && normalize(actual) === normalize(expected);
  });
}

export function findSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  endOfFile: boolean,
): number | undefined {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return undefined;

  const last = lines.length - pattern.length;
  const searchStart = endOfFile ? last : start;
  const normalizers = [(value: string): string => value, rustTrimEnd, rustTrim, normalizeFuzzyText];
  for (const normalize of normalizers) {
    for (let index = searchStart; index <= last; index += 1) {
      if (sequenceMatches(lines, pattern, index, normalize)) return index;
    }
  }
  return undefined;
}

export function withoutCarriageReturn(value: string): string {
  return value.endsWith("\r") ? value.slice(0, -1) : value;
}

export function withLineEnding(line: string, lineEnding: "\n" | "\r\n"): string {
  return lineEnding === "\r\n" && !line.endsWith("\r") ? `${line}\r` : line;
}

export function lineEndingForLine(sourceLines: readonly string[], line: number): "\n" | "\r\n" {
  return sourceLines[line]?.endsWith("\r") ? "\r\n" : "\n";
}

export function lineEndingAtBoundary(sourceLines: readonly string[], line: number): "\n" | "\r\n" {
  const adjacent = sourceLines[line - 1] ?? sourceLines[line];
  return adjacent?.endsWith("\r") ? "\r\n" : "\n";
}
