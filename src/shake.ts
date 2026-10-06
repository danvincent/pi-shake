import type { ShakePart } from "./types.js";
import type { ShakeConfig, ShakeRegion, ShakeResult, MessageEntry } from "./types.js";
import {
  countTokens,
  isAlreadyShaken,
  isErrorResult,
  isProtectedTool,
  isProtectedRead,
  scanBlocks,
  computeSuffixTokens,
} from "./utils.js";

/**
 * Find all shakeable regions in a message list.
 */
export function findShakeRegions(
  entries: MessageEntry[],
  config: ShakeConfig,
  tokenCount: (s: string) => number = countTokens,
): ShakeRegion[] {
  const regions: ShakeRegion[] = [];
  const suffixTokens = computeSuffixTokens(entries, tokenCount);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const suffix = suffixTokens[i];

    for (let j = 0; j < entry.parts.length; j++) {
      const part = entry.parts[j];

      // --- Tool result shaking ---
      if (part.type === "tool") {
        const state = part.state;

        // Only shake completed tool results
        if (state.status !== "completed") continue;

        const output = state.output;
        const toolName = part.tool;

        // Skip if already shaken
        if (isAlreadyShaken(output)) continue;

        // Skip if error
        if (isErrorResult(part)) continue;

        // Skip if tool name is protected
        if (isProtectedTool(toolName, config.protectedToolNames)) continue;

        // Skip if read result matches protected prefix
        if (isProtectedRead(output, config.protectedReadPrefixes)) continue;

        const tokens = tokenCount(output);

        // Check protection window: skip if suffix tokens are within protectTokens
        const isUseful = tokens > 200;
        if (isUseful && suffix < config.protectTokens) continue;

        // Must meet minimum savings
        if (tokens < config.minSavings) continue;

        regions.push({
          messageIndex: i,
          partIndex: j,
          original: output,
          tokens,
          label: toolName,
          kind: "tool-result",
        });
        continue;
      }

      // --- Block shaking in text parts ---
      if (part.type === "text") {
        const text = part.text;

        // Skip if already shaken
        if (isAlreadyShaken(text)) continue;

        const spans = scanBlocks(text, config.fenceMinTokens, tokenCount);

        for (const span of spans) {
          const blockText = text.slice(span.start, span.end);
          const tokens = tokenCount(blockText);

          // Check protection window
          if (suffix < config.protectTokens) continue;

          // Must meet minimum savings
          if (tokens < config.minSavings) continue;

          regions.push({
            messageIndex: i,
            partIndex: j,
            original: blockText,
            tokens,
            label: span.label,
            kind: "block",
          });
        }
      }
    }
  }

  return regions;
}

/**
 * Apply shake regions to the message entries, mutating parts in place.
 */
export function applyShake(
  entries: MessageEntry[],
  regions: ShakeRegion[],
  artifactPath?: string,
): ShakeResult {
  // Sort regions by position (latest first) so replacements don't shift indices
  const sorted = [...regions].sort((a, b) => {
    if (b.messageIndex !== a.messageIndex) return b.messageIndex - a.messageIndex;
    return b.partIndex - a.partIndex;
  });

  let savedTokens = 0;
  let regionIndex = 0;

  for (const region of sorted) {
    const entry = entries[region.messageIndex];
    const part: ShakePart = entry.parts[region.partIndex];

    if (region.kind === "tool-result" && part.type === "tool") {
      const state = part.state;
      if (state.status !== "completed") continue;

      const placeholder = artifactPath
        ? `[shaken ~${region.tokens} tokens — recover: ${artifactPath}#region-${regionIndex}]`
        : `[shaken ~${region.tokens} tokens]`;

      part.state = { ...state, output: placeholder };

      savedTokens += region.tokens;
      regionIndex++;
    } else if (region.kind === "block" && part.type === "text") {
      const text = part.text;
      const idx = text.indexOf(region.original);
      if (idx !== -1) {
        const placeholder = artifactPath
          ? `[shaken ${region.label} block ~${region.tokens} tokens — recover: ${artifactPath}#region-${regionIndex}]`
          : `[shaken ${region.label} block ~${region.tokens} tokens]`;

        part.text = text.slice(0, idx) + placeholder + text.slice(idx + region.original.length);
        savedTokens += region.tokens;
        regionIndex++;
      }
    }
  }

  return {
    savedTokens,
    shakenCount: regionIndex,
    regions,
  };
}

/**
 * Perform a full shake on message entries (mutated in place).
 */
export function shake(
  entries: MessageEntry[],
  config: ShakeConfig,
  artifactPath?: string,
  tokenCount: (s: string) => number = countTokens,
): ShakeResult {
  const regions = findShakeRegions(entries, config, tokenCount);
  return applyShake(entries, regions, artifactPath);
}

/**
 * Remove image content blocks from messages, replacing with "[image removed]".
 * Mutates entries in place.
 */
export function shakeImages(entries: MessageEntry[]): number {
  let removedCount = 0;

  for (const entry of entries) {
    for (let j = 0; j < entry.parts.length; j++) {
      const part = entry.parts[j];
      if (part.type === "file" && part.mime?.startsWith("image/")) {
        entry.parts[j] = { type: "text", text: "[image removed]" };
        removedCount++;
      }
    }
  }

  return removedCount;
}
