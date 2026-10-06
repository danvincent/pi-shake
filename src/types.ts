/** Minimal part union the shake core operates on (decoupled from any host SDK). */
export type ShakePart =
  | { type: "text"; text: string }
  | {
      type: "tool";
      tool: string;
      callID?: string;
      state:
        | { status: "completed"; output: string }
        | { status: "error"; error: string }
        | { status: "pending" };
    }
  | { type: "file"; mime?: string; url?: string };

/** Configuration for the shake operation */
export interface ShakeConfig {
  /** Keep at least this many tokens of recent context untouched */
  protectTokens: number;
  /** Minimum token savings to justify a shake */
  minSavings: number;
  /** Minimum tokens for a fenced block to be eligible for shaking */
  fenceMinTokens: number;
  /** Tool names whose results are never shaken */
  protectedToolNames: string[];
  /** Read tool result prefixes that are never shaken */
  protectedReadPrefixes: string[];
}

/** A region in the message stream eligible for shaking */
export interface ShakeRegion {
  /** Index into the messages array */
  messageIndex: number;
  /** Index into the parts array of that message */
  partIndex: number;
  /** The original content that was replaced */
  original: string;
  /** Token count of the original content */
  tokens: number;
  /** Label for the replacement placeholder (e.g. tool name, "code", "xml") */
  label: string;
  /** Whether this is a whole-tool-result shake or a block shake */
  kind: "tool-result" | "block";
}

/** Result of a shake operation */
export interface ShakeResult {
  /** Total tokens saved */
  savedTokens: number;
  /** Number of regions shaken */
  shakenCount: number;
  /** The shake regions with their replacements */
  regions: ShakeRegion[];
}

/** Message entry as seen by the shake core (info is opaque/host-specific). */
export interface MessageEntry {
  parts: ShakePart[];
  info?: unknown;
}
