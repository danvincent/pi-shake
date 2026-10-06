import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  DEFAULT_SHAKE_CONFIG,
  AGGRESSIVE_SHAKE_CONFIG,
  SHAKE_USER_CONFIG_SCHEMA,
  mergeShakeConfig,
  mergeShakeConfigWithBase,
  loadShakeConfig,
  loadUserShakeConfig,
} from "../src/config.js";

describe("SHAKE_USER_CONFIG_SCHEMA", () => {
  it("accepts a valid partial config", () => {
    assert.ok(SHAKE_USER_CONFIG_SCHEMA.safeParse({ protectTokens: 8000, minSavings: 1000 }).success);
  });

  it("accepts an empty object (all optional)", () => {
    assert.ok(SHAKE_USER_CONFIG_SCHEMA.safeParse({}).success);
  });

  it("rejects non-number protectTokens", () => {
    assert.ok(!SHAKE_USER_CONFIG_SCHEMA.safeParse({ protectTokens: "nope" }).success);
  });

  it("rejects negative protectTokens", () => {
    assert.ok(!SHAKE_USER_CONFIG_SCHEMA.safeParse({ protectTokens: -1 }).success);
  });

  it("rejects non-number minSavings", () => {
    assert.ok(!SHAKE_USER_CONFIG_SCHEMA.safeParse({ minSavings: "nope" }).success);
  });

  it("rejects non-number fenceMinTokens", () => {
    assert.ok(!SHAKE_USER_CONFIG_SCHEMA.safeParse({ fenceMinTokens: "nope" }).success);
  });

  it("rejects unknown keys", () => {
    assert.ok(!SHAKE_USER_CONFIG_SCHEMA.safeParse({ protectTokens: 8000, unknownField: "x" }).success);
  });

  it("accepts all three valid fields", () => {
    const result = SHAKE_USER_CONFIG_SCHEMA.safeParse({ protectTokens: 5000, minSavings: 500, fenceMinTokens: 200 });
    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.data.protectTokens, 5000);
      assert.equal(result.data.minSavings, 500);
      assert.equal(result.data.fenceMinTokens, 200);
    }
  });
});

describe("mergeShakeConfig", () => {
  it("returns defaults when userConfig is undefined", () => {
    assert.deepEqual(mergeShakeConfig(undefined), DEFAULT_SHAKE_CONFIG);
  });

  it("returns defaults when userConfig is empty", () => {
    assert.deepEqual(mergeShakeConfig({}), DEFAULT_SHAKE_CONFIG);
  });

  it("overrides individual fields", () => {
    assert.equal(mergeShakeConfig({ protectTokens: 8000 }).protectTokens, 8000);
    assert.equal(mergeShakeConfig({ minSavings: 1000 }).minSavings, 1000);
    assert.equal(mergeShakeConfig({ fenceMinTokens: 200 }).fenceMinTokens, 200);
  });

  it("overrides multiple fields at once", () => {
    const result = mergeShakeConfig({ protectTokens: 5000, minSavings: 500, fenceMinTokens: 100 });
    assert.equal(result.protectTokens, 5000);
    assert.equal(result.minSavings, 500);
    assert.equal(result.fenceMinTokens, 100);
  });

  it("preserves protected lists from defaults", () => {
    const result = mergeShakeConfig({ protectTokens: 1000 });
    assert.deepEqual(result.protectedToolNames, DEFAULT_SHAKE_CONFIG.protectedToolNames);
    assert.deepEqual(result.protectedReadPrefixes, DEFAULT_SHAKE_CONFIG.protectedReadPrefixes);
  });

  it("does not mutate DEFAULT_SHAKE_CONFIG", () => {
    const original = { ...DEFAULT_SHAKE_CONFIG };
    mergeShakeConfig({ protectTokens: 999 });
    assert.deepEqual(DEFAULT_SHAKE_CONFIG, original);
  });

  it("falls back to defaults on invalid values", () => {
    assert.deepEqual(mergeShakeConfig({ protectTokens: "bad" } as never), DEFAULT_SHAKE_CONFIG);
  });
});

describe("mergeShakeConfigWithBase", () => {
  it("returns base copy when userConfig is undefined", () => {
    assert.deepEqual(mergeShakeConfigWithBase(AGGRESSIVE_SHAKE_CONFIG, undefined), AGGRESSIVE_SHAKE_CONFIG);
  });

  it("overrides base fields", () => {
    const result = mergeShakeConfigWithBase(AGGRESSIVE_SHAKE_CONFIG, { protectTokens: 100 });
    assert.equal(result.protectTokens, 100);
    assert.equal(result.minSavings, AGGRESSIVE_SHAKE_CONFIG.minSavings);
  });
});

describe("loadShakeConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shake-config-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns defaults when no config files exist", () => {
    assert.deepEqual(loadShakeConfig(tmpDir), DEFAULT_SHAKE_CONFIG);
  });

  it("returns defaults when opencode.json has no shake key", () => {
    fs.writeFileSync(path.join(tmpDir, "opencode.json"), JSON.stringify({ model: "x" }), "utf-8");
    assert.deepEqual(loadShakeConfig(tmpDir), DEFAULT_SHAKE_CONFIG);
  });

  it("merges shake config from opencode.json", () => {
    fs.writeFileSync(
      path.join(tmpDir, "opencode.json"),
      JSON.stringify({ shake: { protectTokens: 8000, minSavings: 1000 } }),
      "utf-8",
    );
    const result = loadShakeConfig(tmpDir);
    assert.equal(result.protectTokens, 8000);
    assert.equal(result.minSavings, 1000);
    assert.equal(result.fenceMinTokens, DEFAULT_SHAKE_CONFIG.fenceMinTokens);
  });

  it("reads shake config from .pi/settings.json", () => {
    fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".pi", "settings.json"),
      JSON.stringify({ shake: { protectTokens: 4000 } }),
      "utf-8",
    );
    assert.equal(loadShakeConfig(tmpDir).protectTokens, 4000);
  });

  it("returns defaults when config files are malformed", () => {
    fs.writeFileSync(path.join(tmpDir, "opencode.json"), "not json{{{", "utf-8");
    assert.deepEqual(loadShakeConfig(tmpDir), DEFAULT_SHAKE_CONFIG);
  });

  it("loadUserShakeConfig returns only explicit keys (aggressive base survives)", () => {
    assert.deepEqual(loadUserShakeConfig(tmpDir), {});
    fs.writeFileSync(
      path.join(tmpDir, "opencode.json"),
      JSON.stringify({ shake: { minSavings: 5 } }),
      "utf-8",
    );
    assert.deepEqual(loadUserShakeConfig(tmpDir), { minSavings: 5 });
    // Merged defaults must not leak back as overrides: aggressive keeps protectTokens 0
    const aggr = mergeShakeConfigWithBase(AGGRESSIVE_SHAKE_CONFIG, loadUserShakeConfig(tmpDir));
    assert.equal(aggr.protectTokens, 0);
    assert.equal(aggr.minSavings, 5);
  });

  it("returns defaults when shake config has invalid values", () => {
    fs.writeFileSync(
      path.join(tmpDir, "opencode.json"),
      JSON.stringify({ shake: { protectTokens: "not a number" } }),
      "utf-8",
    );
    assert.deepEqual(loadShakeConfig(tmpDir), DEFAULT_SHAKE_CONFIG);
  });
});
