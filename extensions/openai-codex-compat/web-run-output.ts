const RESULT_SEPARATOR_PATTERN = /(?:\r?\n)?-{80}(?:\r?\n)?/gu;
const CITATION_PATTERN = /cite([^]+)/gu;
const PAGE_LINE_PATTERN = /^L(\d+)(?:@P(\d+)(?:-(\d+))?)?:\s?(.*)$/u;
const EMBEDDED_PAGE_LINE_PATTERN = / (?=L\d+(?:@P\d+(?:-\d+)?)?:)/gu;
const TITLE_URL_PATTERN = /^(.*?)\s*\((https?:\/\/[^)]+)\)\s*$/u;

export type WebRunOutputLine = {
  text: string;
  line?: number;
  page?: number;
  pageEnd?: number;
  heading?: number;
};

export type WebRunOutputBlock = {
  title?: string;
  url?: string;
  references: string[];
  metadata: string[];
  lines: WebRunOutputLine[];
};

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

function citationText(payload: string, references: string[]): string {
  if (/^turn[\w-]+$/u.test(payload)) {
    pushUnique(references, payload);
    return "";
  }
  const separator = payload.indexOf("†");
  return separator < 0 ? payload : payload.slice(separator + 1);
}

function cleanCitations(value: string, references: string[]): string {
  return value
    .replace(CITATION_PATTERN, (_match, payload: string) => citationText(payload, references))
    .trim();
}

function metadataParts(value: string): string[] {
  return value
    .replace(/^\[wordlim:\s*(\d+)\]\s*/u, "$1-word excerpt; ")
    .split(/;\s*/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const contentType = part.match(/^Content type:\s*(.+)$/u);
      if (contentType) {
        const type = contentType[1]!;
        if (type === "text/html") return "HTML";
        if (type === "application/pdf") return "PDF";
        return type;
      }
      const totalLines = part.match(/^Total lines:\s*(\d+)$/u);
      if (totalLines) return `${totalLines[1]} lines`;
      const pages = part.match(/^Number of pages:\s*(\d+)$/u);
      if (pages) return `${pages[1]} pages`;
      return part;
    });
}

function isMetadata(value: string): boolean {
  return (
    value.startsWith("[wordlim:") ||
    /^(?:Published|Crawled|Content type|Source|Total lines|Number of pages):/u.test(value)
  );
}

function parseOutputLine(value: string, references: string[]): WebRunOutputLine {
  const clean = cleanCitations(value, references);
  const pageLine = clean.match(PAGE_LINE_PATTERN);
  if (pageLine) {
    const text = pageLine[4] ?? "";
    const heading = text.match(/^(#{1,6})\s+(.+)$/u);
    const line: WebRunOutputLine = {
      line: Number(pageLine[1]),
      text: heading?.[2] ?? text,
    };
    if (pageLine[2] !== undefined) line.page = Number(pageLine[2]);
    if (pageLine[3] !== undefined) line.pageEnd = Number(pageLine[3]);
    if (heading?.[1]) line.heading = heading[1].length;
    return line;
  }
  const heading = clean.match(/^(#{1,6})\s+(.+)$/u);
  if (heading) {
    return { text: heading[2] ?? "", heading: heading[1]?.length ?? 0 };
  }
  return { text: clean };
}

function parseBlock(value: string): WebRunOutputBlock | undefined {
  const references: string[] = [];
  const rawLines = value
    .replace(EMBEDDED_PAGE_LINE_PATTERN, "\n")
    .split(/\r?\n/u)
    .map((line) => line.trimEnd());
  while (rawLines[0]?.trim() === "") rawLines.shift();
  while (rawLines.at(-1)?.trim() === "") rawLines.pop();
  if (rawLines.length === 0) return undefined;

  const firstLine = cleanCitations(rawLines[0]!, references);
  const header = firstLine.match(TITLE_URL_PATTERN);
  const titleOnly = firstLine.match(/^(.+?)\s*\(\)\s*$/u);
  let title = header?.[1]?.trim() || titleOnly?.[1]?.trim() || undefined;
  const url = header?.[2];
  let bodyStart = header || titleOnly ? 1 : 0;
  if (!header && /^\s*\([^)]*\)\s*$/u.test(firstLine)) {
    bodyStart = 1;
  }

  const metadata: string[] = [];
  while (bodyStart < rawLines.length) {
    const clean = cleanCitations(rawLines[bodyStart]!, references);
    if (!isMetadata(clean)) break;
    metadata.push(...metadataParts(clean));
    bodyStart += 1;
  }

  const lines = rawLines.slice(bodyStart).map((line) => parseOutputLine(line, references));

  if (!title && url) {
    try {
      title = new URL(url).hostname;
    } catch {
      title = url;
    }
  }
  const block: WebRunOutputBlock = {
    references,
    metadata,
    lines,
  };
  if (title) block.title = title;
  if (url) block.url = url;
  return block;
}

export function parseWebRunOutput(output: string): WebRunOutputBlock[] {
  return output
    .split(RESULT_SEPARATOR_PATTERN)
    .map(parseBlock)
    .filter((block): block is WebRunOutputBlock => Boolean(block));
}

export function outputLineRange(
  blocks: readonly WebRunOutputBlock[],
): { first: number; last: number } | undefined {
  const numbers = blocks.flatMap((block) =>
    block.lines.flatMap((line) => (line.line === undefined ? [] : [line.line])),
  );
  if (numbers.length === 0) return undefined;
  return { first: Math.min(...numbers), last: Math.max(...numbers) };
}

export function outputDomains(blocks: readonly WebRunOutputBlock[]): string[] {
  const domains = blocks.flatMap((block) => {
    if (!block.url) return [];
    try {
      return [new URL(block.url).hostname];
    } catch {
      return [];
    }
  });
  return [...new Set(domains)];
}

export function blockPlainText(block: WebRunOutputBlock): string {
  return block.lines
    .map((line) => line.text)
    .filter(Boolean)
    .join(" ");
}
