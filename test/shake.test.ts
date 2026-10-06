import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findShakeRegions, applyShake, shake, shakeImages } from "../src/shake.js";
import type { ShakeConfig, MessageEntry, ShakePart } from "../src/types.js";

function toolPart(tool: string, output: string): ShakePart {
  return { type: "tool", tool, callID: `c-${tool}`, state: { status: "completed", output } };
}

function errorToolPart(tool: string, error: string): ShakePart {
  return { type: "tool", tool, callID: `c-${tool}`, state: { status: "error", error } };
}

function textPart(text: string): ShakePart {
  return { type: "text", text };
}

function entry(parts: ShakePart[]): MessageEntry {
  return { parts };
}

const TEST_CONFIG: ShakeConfig = {
  protectTokens: 0,
  minSavings: 0,
  fenceMinTokens: 5,
  protectedToolNames: ["ask", "question", "todo"],
  protectedReadPrefixes: ["AGENTS.md", ".opencode/", ".pi/"],
};

describe("findShakeRegions", () => {
  it("finds shakeable tool results", () => {
    const regions = findShakeRegions([entry([toolPart("bash", "some long output here")])], TEST_CONFIG);
    assert.equal(regions.length, 1);
    assert.equal(regions[0].kind, "tool-result");
    assert.equal(regions[0].label, "bash");
  });

  it("skips protected tool names", () => {
    assert.equal(findShakeRegions([entry([toolPart("ask", "should not be shaken")])], TEST_CONFIG).length, 0);
  });

  it("skips already-shaken results", () => {
    assert.equal(findShakeRegions([entry([toolPart("bash", "[shaken ~100 tokens]")])], TEST_CONFIG).length, 0);
  });

  it("skips error results", () => {
    assert.equal(findShakeRegions([entry([errorToolPart("bash", "error output")])], TEST_CONFIG).length, 0);
  });

  it("skips protected read prefixes", () => {
    assert.equal(findShakeRegions([entry([toolPart("read", "AGENTS.md content here")])], TEST_CONFIG).length, 0);
    assert.equal(findShakeRegions([entry([toolPart("read", ".pi/settings.json")])], TEST_CONFIG).length, 0);
  });

  it("finds block regions in text", () => {
    const codeBlock = "```python\n" + "print('hello world')\n".repeat(10) + "```";
    const regions = findShakeRegions([entry([textPart("Some text\n" + codeBlock + "\nMore text")])], TEST_CONFIG);
    assert.ok(regions.length >= 1);
    assert.equal(regions[0].kind, "block");
  });

  it("respects protectTokens window", () => {
    const longOutput = "The quick brown fox jumps over the lazy dog. ".repeat(100);
    const config: ShakeConfig = { ...TEST_CONFIG, protectTokens: 100_000 };
    const regions = findShakeRegions([entry([toolPart("bash", longOutput)])], config);
    assert.equal(regions.length, 0);
  });

  it("respects minSavings", () => {
    const config: ShakeConfig = { ...TEST_CONFIG, minSavings: 1000 };
    const regions = findShakeRegions([entry([toolPart("bash", "short")])], config);
    assert.equal(regions.length, 0);
  });
});

describe("applyShake", () => {
  it("replaces tool result with placeholder", () => {
    const entries = [entry([toolPart("bash", "long output here")])];
    const regions = findShakeRegions(entries, TEST_CONFIG);
    assert.equal(regions.length, 1);
    const result = applyShake(entries, regions);
    assert.ok(result.shakenCount > 0);
    assert.ok(result.savedTokens > 0);
    const part = entries[0].parts[0];
    assert.ok(part.type === "tool" && part.state.status === "completed" && part.state.output.startsWith("[shaken"));
  });

  it("includes artifact path in placeholder when provided", () => {
    const entries = [entry([toolPart("bash", "long output here")])];
    applyShake(entries, findShakeRegions(entries, TEST_CONFIG), "/tmp/artifact.md");
    const part = entries[0].parts[0];
    assert.ok(
      part.type === "tool" &&
        part.state.status === "completed" &&
        part.state.output.includes("recover: /tmp/artifact.md#region-0"),
    );
  });

  it("replaces block regions in text", () => {
    const codeBlock = "```\n" + "x = 1\n".repeat(5) + "```";
    const entries = [entry([textPart("Before\n" + codeBlock + "\nAfter")])];
    const regions = findShakeRegions(entries, TEST_CONFIG);
    assert.ok(regions.length >= 1);
    applyShake(entries, regions);
    const part = entries[0].parts[0];
    assert.ok(part.type === "text" && part.text.includes("[shaken"));
    assert.ok(part.type === "text" && !part.text.includes("x = 1"));
    assert.ok(part.type === "text" && part.text.includes("Before"));
  });
});

describe("shake", () => {
  it("shakes multiple regions in one pass", () => {
    const result = shake([entry([toolPart("bash", "output 1")]), entry([toolPart("read", "output 2")])], TEST_CONFIG);
    assert.ok(result.shakenCount >= 2);
    assert.ok(result.savedTokens > 0);
  });

  it("returns zero when nothing to shake", () => {
    const result = shake([entry([toolPart("ask", "protected")])], TEST_CONFIG);
    assert.equal(result.shakenCount, 0);
    assert.equal(result.savedTokens, 0);
  });

  it("skips already-shaken entries", () => {
    const result = shake([entry([toolPart("bash", "[shaken ~100 tokens]")])], TEST_CONFIG);
    assert.equal(result.shakenCount, 0);
  });
});

describe("shakeImages", () => {
  it("removes image parts", () => {
    const entries = [entry([{ type: "file", mime: "image/png", url: "data:..." }, textPart("keep this")])];
    assert.equal(shakeImages(entries), 1);
    const first = entries[0].parts[0];
    assert.ok(first.type === "text" && first.text === "[image removed]");
    const second = entries[0].parts[1];
    assert.ok(second.type === "text" && second.text.includes("keep this"));
  });

  it("returns 0 when no images", () => {
    assert.equal(shakeImages([entry([textPart("no images here")])]), 0);
  });

  it("handles multiple images across entries", () => {
    const entries = [
      entry([{ type: "file", mime: "image/jpeg", url: "data:..." }]),
      entry([{ type: "file", mime: "image/png", url: "data:..." }]),
    ];
    assert.equal(shakeImages(entries), 2);
  });
});
