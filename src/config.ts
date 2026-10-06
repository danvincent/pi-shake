import * as fs from "node:fs";
import * as path from "node:path";
import type { ShakeConfig } from "./types.js";

/** User-overridable shake settings (all fields optional) */
export interface UserShakeConfig {
  protectTokens?: number;
  minSavings?: number;
  fenceMinTokens?: number;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isValidUserConfig(v: unknown): v is UserShakeConfig {
  if (typeof v !== "object" || v === null) return false;
  const allowed = ["protectTokens", "minSavings", "fenceMinTokens"];
  for (const key of Object.keys(v)) {
    if (!allowed.includes(key)) return false;
  }
  const o = v as Record<string, unknown>;
  for (const key of allowed) {
    if (o[key] !== undefined && !isNonNegativeInt(o[key])) return false;
  }
  return true;
}

/**
 * Minimal zod-compatible validator for user shake config (no zod dependency).
 * Keeps the same safeParse API the opencode tests exercise.
 */
export const SHAKE_USER_CONFIG_SCHEMA = {
  safeParse(
    v: unknown,
  ): { success: true; data: UserShakeConfig } | { success: false; error: Error } {
    if (!isValidUserConfig(v)) {
      return { success: false, error: new Error("invalid shake config") };
    }
    return { success: true, data: v };
  },
};

/** Conservative config for automatic shakes (per-request context transform) */
export const DEFAULT_SHAKE_CONFIG: ShakeConfig = {
  protectTokens: 32_000,
  minSavings: 1_000,
  fenceMinTokens: 200,
  protectedToolNames: ["ask", "question", "todo"],
  protectedReadPrefixes: ["AGENTS.md", ".opencode/", ".pi/", "skill://"],
};

/** Aggressive config for manual shakes (shake_context tool / /shake).
 *  NOTE: deviates from opencode-shake src (which kept 32_000): aggressive
 *  means everything is eligible, per opencode-shake's own README. */
export const AGGRESSIVE_SHAKE_CONFIG: ShakeConfig = {
  protectTokens: 0,
  minSavings: 0,
  fenceMinTokens: 400,
  protectedToolNames: ["ask", "question", "todo"],
  protectedReadPrefixes: ["AGENTS.md", ".opencode/", ".pi/", "skill://"],
};

/**
 * Merge user overrides with DEFAULT_SHAKE_CONFIG.
 * User values win; unprovided fields keep defaults.
 */
export function mergeShakeConfig(userConfig: UserShakeConfig | undefined): ShakeConfig {
  if (!userConfig) return { ...DEFAULT_SHAKE_CONFIG };

  const validated = SHAKE_USER_CONFIG_SCHEMA.safeParse(userConfig);
  if (!validated.success) {
    return { ...DEFAULT_SHAKE_CONFIG };
  }

  const { protectTokens, minSavings, fenceMinTokens } = validated.data;
  return {
    ...DEFAULT_SHAKE_CONFIG,
    ...(protectTokens !== undefined && { protectTokens }),
    ...(minSavings !== undefined && { minSavings }),
    ...(fenceMinTokens !== undefined && { fenceMinTokens }),
  };
}

/**
 * Merge user overrides with a given base config.
 * Used for AGGRESSIVE_SHAKE_CONFIG too.
 */
export function mergeShakeConfigWithBase(
  base: ShakeConfig,
  userConfig: UserShakeConfig | undefined,
): ShakeConfig {
  if (!userConfig) return { ...base };

  const validated = SHAKE_USER_CONFIG_SCHEMA.safeParse(userConfig);
  if (!validated.success) {
    return { ...base };
  }

  const { protectTokens, minSavings, fenceMinTokens } = validated.data;
  return {
    ...base,
    ...(protectTokens !== undefined && { protectTokens }),
    ...(minSavings !== undefined && { minSavings }),
    ...(fenceMinTokens !== undefined && { fenceMinTokens }),
  };
}

function readShakeKey(dir: string, file: string): UserShakeConfig | undefined {
  try {
    const configPath = path.join(dir, file);
    if (!fs.existsSync(configPath)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const userShake = parsed?.shake;
    if (!userShake || typeof userShake !== "object") return undefined;
    return userShake as UserShakeConfig;
  } catch {
    return undefined;
  }
}

/**
 * Read only the explicitly set user shake keys for a Pi project directory.
 * Checks `opencode.json` (compat) then `.pi/settings.json`; later files win.
 * Returns `{}` when nothing is set — so aggressive-base defaults survive.
 */
export function loadUserShakeConfig(worktree: string): UserShakeConfig {
  const fromOpencode = readShakeKey(worktree, "opencode.json");
  const fromPi = readShakeKey(path.join(worktree, ".pi"), "settings.json");
  return { ...fromOpencode, ...fromPi };
}

/**
 * Read user shake config for a Pi project directory.
 * Returns the merged ShakeConfig (explicit user overrides + DEFAULT_SHAKE_CONFIG).
 */
export function loadShakeConfig(worktree: string): ShakeConfig {
  return mergeShakeConfig(loadUserShakeConfig(worktree));
}
