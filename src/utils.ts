import type { ShakePart } from "./types.js";

// Lazy-loaded tiktoken encoder (optional; falls back to char/4)
// ponytail: no new tokenizer dep, reuse tiktoken only if host already provides it
let _encoder: { encode: (text: string) => number[] } | null | undefined;

function getEncoder(): { encode: (text: string) => number[] } | null {
  if (_encoder !== undefined) return _encoder;
  _encoder = null;
  try {
    const r = (globalThis as unknown as { require?: unknown }).require;
    if (typeof r === "function") {
      const { encoding_for_model } = (
        r as (id: string) => Record<string, (m: string) => unknown>
      )("tiktoken");
      _encoder = encoding_for_model("gpt-4") as unknown as {
        encode: (text: string) => number[];
      };
    }
  } catch {
    _encoder = null;
  }
  return _encoder;
}

/** Count tokens in a string. Uses tiktoken if available, falls back to char/4. */
export function countTokens(text: string): number {
  if (!text) return 0;
  const encoder = getEncoder();
  if (encoder) {
    try {
      return encoder.encode(text).length;
    } catch {
      // fall through
    }
  }
  return Math.ceil(text.length / 4);
}

/** Check if a tool result is already shaken or superseded */
export function isAlreadyShaken(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("[shaken") || trimmed.startsWith("[Superseded");
}

/** Check if a tool result is an error */
export function isErrorResult(part: ShakePart): boolean {
  if (part.type !== "tool") return false;
  return part.state.status === "error";
}

/** Check if a tool name is protected */
export function isProtectedTool(toolName: string, protectedNames: string[]): boolean {
  return protectedNames.includes(toolName);
}

/** Check if a tool result's output matches a protected read prefix */
export function isProtectedRead(output: string, protectedPrefixes: string[]): boolean {
  const trimmed = output.trimStart();
  return protectedPrefixes.some((prefix) => trimmed.startsWith(prefix));
}

/** Get the output text from a completed tool result part */
export function getToolOutput(part: ShakePart): string | null {
  if (part.type !== "tool") return null;
  const state = part.state;
  if (state.status === "completed") return state.output;
  if (state.status === "error") return state.error;
  return null;
}

/** Get the tool name from a tool part */
export function getToolName(part: ShakePart): string | null {
  if (part.type !== "tool") return null;
  return part.tool;
}

/** Get the call ID from a tool part */
export function getCallID(part: ShakePart): string | null {
  if (part.type !== "tool") return null;
  return part.callID ?? null;
}

export interface BlockSpan {
  start: number;
  end: number;
  label: string;
}

/**
 * Scan text for fenced code blocks (``` or ~~~) and top-level XML tags.
 * Returns non-overlapping spans sorted by start position.
 * Only considers spans >= minTokens tokens.
 */
export function scanBlocks(
  text: string,
  minTokens: number,
  tokenCounter: (s: string) => number = countTokens,
): BlockSpan[] {
  const spans: BlockSpan[] = [];

  // Fenced code blocks: ``` or ~~~
  const fenceRegex = /(^|\n)(```|~~~)([^\n]*)\n([\s\S]*?)\n\2\s*(?:\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(text)) !== null) {
    const fullMatch = match[0];
    const start = match.index + (match[1]?.length ?? 0);
    const end = start + fullMatch.length - (match[1]?.length ?? 0);
    const lang = match[3]?.trim() || match[2];
    const content = match[4] || "";
    const tokens = tokenCounter(content);
    if (tokens >= minTokens) {
      spans.push({ start, end, label: lang || "code" });
    }
  }

  // Top-level XML-like tags (lowercase only, not self-closing)
  const xmlRegex = /<(?<tag>[a-z][a-z0-9]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
  while ((match = xmlRegex.exec(text)) !== null) {
    const fullMatch = match[0];
    const content = match[2] || "";
    const tokens = tokenCounter(content);
    if (tokens >= minTokens) {
      spans.push({
        start: match.index,
        end: match.index + fullMatch.length,
        label: match.groups?.tag || "xml",
      });
    }
  }

  // Sort by start position
  spans.sort((a, b) => a.start - b.start);

  // Merge overlapping spans, keeping outermost
  const merged: BlockSpan[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) {
      if (span.end > last.end) {
        last.end = span.end;
      }
    } else {
      merged.push({ ...span });
    }
  }

  return merged;
}

/**
 * Replace block spans in text with placeholders.
 * Returns the modified text and the original spans with their token counts.
 */
export function replaceBlocks(
  text: string,
  spans: BlockSpan[],
  tokenCounter: (s: string) => number = countTokens,
): { text: string; replacements: Array<{ original: string; tokens: number; label: string }> } {
  if (spans.length === 0) return { text, replacements: [] };

  const replacements: Array<{ original: string; tokens: number; label: string }> = [];
  let result = "";
  let lastEnd = 0;

  for (const span of spans) {
    const original = text.slice(span.start, span.end);
    const tokens = tokenCounter(original);
    replacements.push({ original, tokens, label: span.label });
    result += text.slice(lastEnd, span.start);
    result += `[shaken ${span.label} block ~${tokens} tokens]`;
    lastEnd = span.end;
  }
  result += text.slice(lastEnd);

  return { text: result, replacements };
}

/**
 * Get the suffix token count for each entry in a message list.
 * suffixTokens[i] = total tokens in all entries after index i.
 */
export function computeSuffixTokens(
  entries: Array<{ parts: ShakePart[] }>,
  tokenCounter: (s: string) => number = countTokens,
): number[] {
  const n = entries.length;
  const suffixTokens = new Array<number>(n).fill(0);
  let total = 0;
  for (let i = n - 1; i >= 0; i--) {
    suffixTokens[i] = total;
    for (const part of entries[i].parts) {
      if (part.type === "text") {
        total += tokenCounter(part.text);
      } else if (part.type === "tool") {
        const state = part.state;
        if (state.status === "completed") {
          total += tokenCounter(state.output);
        } else if (state.status === "error") {
          total += tokenCounter(state.error);
        }
      }
    }
  }
  return suffixTokens;
}
