import type { MessageEntry, ShakePart } from "./types.js";

/**
 * Structural mirror of the Pi AgentMessage shapes the adapter cares about.
 * Defined structurally (no Pi import) so src stays dependency-free and testable.
 */
export type AdapterBlock = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [k: string]: unknown;
};

export type AdapterMessage = {
  role: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  command?: string;
  output?: string;
  [k: string]: unknown;
};

function textOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => (b as AdapterBlock)?.type === "text")
    .map((b) => String((b as AdapterBlock).text ?? ""))
    .join("\n");
}

function isImageBlock(b: unknown): b is AdapterBlock {
  return (b as AdapterBlock)?.type === "image";
}

/** Convert Pi messages to shake entries (fresh string copies; safe to mutate). */
export function toShakeEntries(messages: AdapterMessage[]): MessageEntry[] {
  return messages.map((msg) => {
    const parts: ShakePart[] = [];
    switch (msg.role) {
      case "toolResult": {
        const toolName = String(msg.toolName ?? "tool");
        if (msg.isError) {
          parts.push({ type: "tool", tool: toolName, state: { status: "error", error: textOf(msg.content) } });
        } else {
          parts.push({
            type: "tool",
            tool: toolName,
            state: { status: "completed", output: textOf(msg.content) },
          });
        }
        if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (isImageBlock(b)) {
              parts.push({ type: "file", mime: String(b.mimeType ?? "image/unknown") });
            }
          }
        }
        break;
      }
      case "bashExecution": {
        parts.push({
          type: "tool",
          tool: "bash",
          state: { status: "completed", output: String(msg.output ?? "") },
        });
        break;
      }
      case "user":
      case "custom": {
        const content = msg.content;
        if (typeof content === "string") {
          parts.push({ type: "text", text: content });
        } else if (Array.isArray(content)) {
          for (const b of content) {
            const block = b as AdapterBlock;
            if (block?.type === "text") {
              parts.push({ type: "text", text: String(block.text ?? "") });
            } else if (isImageBlock(block)) {
              parts.push({ type: "file", mime: String(block.mimeType ?? "image/unknown") });
            }
          }
        }
        break;
      }
      case "assistant": {
        if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            const block = b as AdapterBlock;
            // Only plain text is shakeable; thinking signatures and tool calls are left alone
            if (block?.type === "text" && typeof block.text === "string") {
              parts.push({ type: "text", text: block.text });
            }
          }
        }
        break;
      }
      default:
        // system, branchSummary, compactionSummary and unknown roles: never shaken
        break;
    }
    return { parts };
  });
}

function shakenPlaceholder(s: string): boolean {
  return s.trimStart().startsWith("[shaken");
}

/**
 * Write mutated entry parts back into the original messages (in place).
 * Must be called with the same messages array passed to toShakeEntries.
 */
export function writeBack(messages: AdapterMessage[], entries: MessageEntry[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const entry = entries[i];
    if (!entry || entry.parts.length === 0) continue;

    switch (msg.role) {
      case "toolResult": {
        let k = 0;
        const toolPart = entry.parts[k++];
        if (toolPart?.type === "tool" && toolPart.state.status === "completed" && shakenPlaceholder(toolPart.state.output)) {
          const placeholder = toolPart.state.output;
          const rest = Array.isArray(msg.content) ? (msg.content as AdapterBlock[]).filter((b) => b?.type !== "text") : [];
          (msg as Record<string, unknown>).content = [{ type: "text", text: placeholder }, ...rest];
        }
        if (Array.isArray(msg.content)) {
          const content = msg.content as AdapterBlock[];
          for (let c = 0; c < content.length; c++) {
            if (isImageBlock(content[c])) {
              const filePart = entry.parts[k++];
              if (filePart?.type === "text") {
                content[c] = { type: "text", text: filePart.text };
              }
            }
          }
        }
        break;
      }
      case "bashExecution": {
        const toolPart = entry.parts[0];
        if (toolPart?.type === "tool" && toolPart.state.status === "completed" && shakenPlaceholder(toolPart.state.output)) {
          (msg as Record<string, unknown>).output = toolPart.state.output;
        }
        break;
      }
      case "user":
      case "custom": {
        if (typeof msg.content === "string") {
          const textPart = entry.parts[0];
          if (textPart?.type === "text" && textPart.text !== msg.content) {
            (msg as Record<string, unknown>).content = textPart.text;
          }
        } else if (Array.isArray(msg.content)) {
          let k = 0;
          for (const block of msg.content as AdapterBlock[]) {
            const part = entry.parts[k++];
            if (!part) break;
            if (block?.type === "text" && part.type === "text") {
              if (block.text !== part.text) block.text = part.text;
            } else if (isImageBlock(block) && part.type === "text") {
              (block as Record<string, unknown>).type = "text";
              (block as Record<string, unknown>).text = part.text;
              delete (block as Record<string, unknown>).data;
              delete (block as Record<string, unknown>).mimeType;
            }
          }
        }
        break;
      }
      case "assistant": {
        if (Array.isArray(msg.content)) {
          let k = 0;
          for (const block of msg.content as AdapterBlock[]) {
            if (block?.type === "text" && typeof block.text === "string") {
              const part = entry.parts[k++];
              if (part?.type === "text" && block.text !== part.text) {
                block.text = part.text;
              }
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }
}
