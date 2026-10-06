import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  AGGRESSIVE_SHAKE_CONFIG,
  loadUserShakeConfig,
  mergeShakeConfig,
  mergeShakeConfigWithBase,
  type UserShakeConfig,
} from "../src/config.js";
import { shake, shakeImages } from "../src/shake.js";
import { toShakeEntries, writeBack, type AdapterMessage } from "../src/pi-adapter.js";
import type { ShakeConfig, ShakeResult } from "../src/types.js";

/** Armed manual shake, consumed once by the next `context` event. */
let pending: {
  elide: boolean;
  images: boolean;
  aggressive: boolean;
  artifactPath?: string;
} | null = null;

function getConfigs(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): { conservative: ShakeConfig; aggressive: ShakeConfig } {
  // Explicit keys only: merged defaults must not clobber the aggressive base.
  const user: UserShakeConfig = loadUserShakeConfig(ctx.cwd);
  try {
    const settings = pi.getSettings() as unknown as Record<string, unknown>;
    if (settings && typeof settings.shake === "object" && settings.shake !== null) {
      Object.assign(user, settings.shake as UserShakeConfig);
    }
  } catch {
    // settings unavailable; file config alone is fine
  }
  return {
    conservative: mergeShakeConfig(user),
    aggressive: mergeShakeConfigWithBase(AGGRESSIVE_SHAKE_CONFIG, user),
  };
}

/** Live branch messages for dry-run counts (strings are copied; never mutated). */
function branchMessages(ctx: ExtensionContext): AdapterMessage[] {
  const out: AdapterMessage[] = [];
  try {
    const branch = ctx.sessionManager.getBranch() as unknown as Array<Record<string, unknown>>;
    for (const e of branch) {
      if (e?.type === "message" && e.message && typeof e.message === "object") {
        out.push(e.message as unknown as AdapterMessage);
      }
    }
  } catch {
    // best effort; empty means "nothing to shake"
  }
  return out;
}

function newArtifactPath(cwd: string, sessionId: string): string {
  const dir = path.join(cwd, ".pi", ".shake");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `shake-${sessionId}-${Date.now()}.md`);
}

function writeArtifact(artifactPath: string, sessionId: string, result: ShakeResult): void {
  const lines: string[] = [
    `# Shake Artifact`,
    ``,
    `Session: ${sessionId}`,
    `Time: ${new Date().toISOString()}`,
    `Regions: ${result.shakenCount}`,
    `Tokens saved: ~${result.savedTokens}`,
    ``,
  ];
  for (let i = 0; i < result.regions.length; i++) {
    const r = result.regions[i];
    lines.push(`## region-${i} (${r.label}, ~${r.tokens} tokens)`);
    lines.push(``);
    lines.push("```");
    lines.push(r.original);
    lines.push("```");
    lines.push(``);
  }
  fs.writeFileSync(artifactPath, lines.join("\n"), "utf-8");
}

function sessionIdOf(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionId() ?? "session";
  } catch {
    return "session";
  }
}

/**
 * Dry-run over branch history for counts, then arm the next `context`
 * event to apply the real shake (transient per-request transform).
 */
async function performShake(
  ctx: ExtensionContext,
  mode: "elide" | "images" | "both",
  aggressive: boolean,
  conservative: ShakeConfig,
  aggressiveConfig: ShakeConfig,
): Promise<string> {
  const messages = branchMessages(ctx);
  if (messages.length === 0) return "No messages to shake.";

  const entries = toShakeEntries(messages);
  let result: ShakeResult = { savedTokens: 0, shakenCount: 0, regions: [] };
  if (mode === "elide" || mode === "both") {
    result = shake(entries, aggressive ? aggressiveConfig : conservative);
  }
  let removed = 0;
  if (mode === "images" || mode === "both") {
    removed = shakeImages(entries);
  }

  if (result.shakenCount === 0 && removed === 0) {
    return "Nothing to shake — context is already lean.";
  }

  const artifactPath =
    result.shakenCount > 0 ? newArtifactPath(ctx.cwd, sessionIdOf(ctx)) : undefined;
  pending = {
    elide: mode === "elide" || mode === "both",
    images: mode === "images" || mode === "both",
    aggressive,
    artifactPath,
  };

  const bits: string[] = [];
  if (result.shakenCount > 0) {
    bits.push(`${result.shakenCount} regions, ~${result.savedTokens} tokens saved`);
  }
  if (removed > 0) bits.push(`${removed} image(s) removed`);
  let summary = `Shake armed: ${bits.join("; ")} — applies on the next request.`;
  if (artifactPath) summary += `\nOriginals will be saved to: ${artifactPath}`;
  return summary;
}

export default function shakeExtension(pi: ExtensionAPI) {
  // Auto-shake: conservative elide on every request (transient, no artifacts).
  pi.on("context", async (event, ctx) => {
    try {
      const messages = (event as unknown as { messages?: AdapterMessage[] }).messages;
      if (!messages || messages.length === 0) return;

      const armed = pending;
      pending = null;
      const { conservative, aggressive } = getConfigs(pi, ctx);
      const doElide = !armed || armed.elide;
      const doImages = !!armed?.images;
      if (!doElide && !doImages) return;

      const config = armed?.aggressive ? aggressive : conservative;
      const artifactPath = armed?.artifactPath;
      if (artifactPath) {
        try {
          fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
        } catch {
          // artifact dir best effort; shake proceeds without recover links
        }
      }

      const entries = toShakeEntries(messages);
      let result: ShakeResult = { savedTokens: 0, shakenCount: 0, regions: [] };
      if (doElide) result = shake(entries, config, artifactPath);
      let removed = 0;
      if (doImages) removed = shakeImages(entries);
      if (result.shakenCount === 0 && removed === 0) return;

      writeBack(messages, entries);
      if (artifactPath && result.shakenCount > 0) {
        try {
          writeArtifact(artifactPath, sessionIdOf(ctx), result);
        } catch {
          // artifact is recovery nicety; never break the pipeline
        }
      }

      const bits: string[] = [];
      if (result.shakenCount > 0) {
        bits.push(`${armed?.aggressive ? "Manual" : "Auto"}: ${result.shakenCount} regions, ~${result.savedTokens} tokens saved`);
      }
      if (removed > 0) bits.push(`${removed} image(s) removed`);
      try {
        ctx.ui.notify(`Context Shake — ${bits.join("; ")}`, "info");
      } catch {
        // notify is informational only
      }
      return { messages: messages as never };
    } catch {
      // A shake failure must never break the model request pipeline
    }
  });

  const shakeTool = defineTool({
    name: "shake_context",
    label: "Shake Context",
    description:
      "Remove old tool outputs and large code/XML blocks from context to free up token space. " +
      "Originals are saved to .pi/.shake/ for recovery.",
    parameters: Type.Object({
      mode: Type.Optional(
        Type.Union([Type.Literal("elide"), Type.Literal("images"), Type.Literal("both")]),
      ),
      aggressive: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const p = params as { mode?: "elide" | "images" | "both"; aggressive?: boolean };
      const mode = p.mode ?? "elide";
      const aggressive = p.aggressive ?? true;
      const { conservative, aggressive: aggressiveConfig } = getConfigs(pi, ctx);
      const summary = await performShake(ctx, mode, aggressive, conservative, aggressiveConfig);
      return { content: [{ type: "text", text: summary }], details: { mode, aggressive } };
    },
  });
  pi.registerTool(shakeTool);

  pi.registerCommand("shake", {
    description: "Reduce context by eliding old outputs and large blocks",
    handler: async (args, ctx) => {
      const a = args.trim().toLowerCase();
      const mode = a.includes("both") ? "both" : a.includes("image") ? "images" : "elide";
      const { conservative, aggressive } = getConfigs(pi, ctx);
      const summary = await performShake(ctx, mode, true, conservative, aggressive);
      ctx.ui.notify(summary, "info");
    },
  });
}
