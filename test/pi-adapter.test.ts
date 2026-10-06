import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toShakeEntries, writeBack, type AdapterMessage } from "../src/pi-adapter.js";
import { shake, shakeImages } from "../src/shake.js";
import { DEFAULT_SHAKE_CONFIG, AGGRESSIVE_SHAKE_CONFIG } from "../src/config.js";

const AGGRESSIVE_NO_WINDOW = { ...AGGRESSIVE_SHAKE_CONFIG, protectTokens: 0 };

function toolResult(toolName: string, text: string): AdapterMessage {
  return { role: "toolResult", toolCallId: "c1", toolName, content: [{ type: "text", text }], isError: false };
}

describe("pi-adapter", () => {
  it("elides old tool results and protects recent context", () => {
    const oldOutput = "old bash output ".repeat(200);
    const messages: AdapterMessage[] = [
      toolResult("bash", oldOutput),
      { role: "user", content: "recent question" },
      toolResult("bash", "fresh output"),
    ];
    const entries = toShakeEntries(messages);
    // Conservative gate: huge protectTokens shields everything recent
    const shielded = shake(entries, { ...DEFAULT_SHAKE_CONFIG, protectTokens: 1_000_000 });
    assert.equal(shielded.shakenCount, 0);

    // Aggressive with no window shakes the old output
    const entries2 = toShakeEntries(messages);
    const result = shake(entries2, AGGRESSIVE_NO_WINDOW);
    assert.ok(result.shakenCount >= 1);
    writeBack(messages, entries2);
    const first = messages[0] as { content: Array<{ text: string }> };
    assert.ok(first.content[0].text.startsWith("[shaken"));
  });

  it("maps bashExecution messages to bash tool parts", () => {
    const messages: AdapterMessage[] = [{ role: "bashExecution", command: "ls", output: "file output ".repeat(100) }];
    const entries = toShakeEntries(messages);
    const result = shake(entries, AGGRESSIVE_NO_WINDOW);
    assert.equal(result.shakenCount, 1);
    assert.equal(result.regions[0].label, "bash");
    writeBack(messages, entries);
    assert.ok((messages[0] as { output: string }).output.startsWith("[shaken"));
  });

  it("elides large fenced blocks in user text", () => {
    const block = "```python\n" + "print('hello world')\n".repeat(100) + "```";
    const messages: AdapterMessage[] = [{ role: "user", content: `help with this\n${block}\nthanks` }];
    const entries = toShakeEntries(messages);
    const result = shake(entries, AGGRESSIVE_NO_WINDOW);
    assert.ok(result.shakenCount >= 1);
    writeBack(messages, entries);
    const content = (messages[0] as { content: string }).content;
    assert.ok(content.includes("[shaken python block"));
    assert.ok(content.includes("help with this"));
  });

  it("never shakes system messages or protected tools", () => {
    const messages: AdapterMessage[] = [
      { role: "system", content: "```\n" + "system block ".repeat(500) + "\n```" },
      toolResult("ask", "protected answer ".repeat(100)),
      toolResult("read", "AGENTS.md instructions ".repeat(100)),
    ];
    const entries = toShakeEntries(messages);
    assert.equal(shake(entries, AGGRESSIVE_NO_WINDOW).shakenCount, 0);
  });

  it("removes images and writes them back as placeholders", () => {
    const messages: AdapterMessage[] = [
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "abc" }] },
    ];
    const entries = toShakeEntries(messages);
    assert.equal(shakeImages(entries), 1);
    writeBack(messages, entries);
    const content = (messages[0] as { content: Array<{ type: string; text?: string }> }).content;
    assert.equal(content[1].type, "text");
    assert.equal(content[1].text, "[image removed]");
    assert.equal(content[0].text, "look");
  });

  it("second shake is a no-op (already-shaken detection)", () => {
    const live: AdapterMessage[] = [toolResult("bash", "output ".repeat(300))];
    const e1 = toShakeEntries(live);
    assert.equal(shake(e1, AGGRESSIVE_NO_WINDOW).shakenCount, 1);
    writeBack(live, e1);
    // Re-derive entries from the mutated messages: nothing left to shake
    const e2 = toShakeEntries(live);
    assert.equal(shake(e2, AGGRESSIVE_NO_WINDOW).shakenCount, 0);
  });
});
