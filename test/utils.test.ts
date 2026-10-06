import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  countTokens,
  isAlreadyShaken,
  isErrorResult,
  isProtectedTool,
  isProtectedRead,
  getToolOutput,
  getToolName,
  getCallID,
  scanBlocks,
  replaceBlocks,
  computeSuffixTokens,
} from "../src/utils.js";
import type { ShakePart } from "../src/types.js";

function toolPart(tool: string, output: string): ShakePart {
  return { type: "tool", tool, callID: `c-${tool}`, state: { status: "completed", output } };
}

function errorPart(tool: string, error: string): ShakePart {
  return { type: "tool", tool, callID: `c-${tool}`, state: { status: "error", error } };
}

describe("countTokens", () => {
  it("returns 0 for empty string", () => {
    assert.equal(countTokens(""), 0);
  });

  it("returns positive for non-empty string", () => {
    assert.ok(countTokens("hello world") > 0);
  });

  it("scales roughly with length", () => {
    assert.ok(countTokens("a".repeat(1000)) > countTokens("hi"));
  });
});

describe("isAlreadyShaken", () => {
  it("detects [shaken ...]", () => {
    assert.ok(isAlreadyShaken("[shaken ~100 tokens]"));
  });

  it("detects [Superseded ...]", () => {
    assert.ok(isAlreadyShaken("[Superseded by compaction]"));
  });

  it("detects with leading whitespace", () => {
    assert.ok(isAlreadyShaken("  [shaken ~50 tokens]"));
  });

  it("rejects normal text", () => {
    assert.ok(!isAlreadyShaken("This is normal output."));
  });

  it("rejects partial match", () => {
    assert.ok(!isAlreadyShaken("shaken ~100 tokens]"));
  });
});

describe("isErrorResult", () => {
  it("returns true for error tool state", () => {
    assert.ok(isErrorResult(errorPart("bash", "command failed")));
  });

  it("returns false for completed tool state", () => {
    assert.ok(!isErrorResult(toolPart("bash", "done")));
  });

  it("returns false for non-tool part", () => {
    assert.ok(!isErrorResult({ type: "text", text: "hello" }));
  });
});

describe("isProtectedTool", () => {
  it("returns true for protected names", () => {
    assert.ok(isProtectedTool("ask", ["ask", "question", "todo"]));
    assert.ok(isProtectedTool("question", ["ask", "question", "todo"]));
    assert.ok(isProtectedTool("todo", ["ask", "question", "todo"]));
  });

  it("returns false for unprotected names", () => {
    assert.ok(!isProtectedTool("bash", ["ask", "question", "todo"]));
    assert.ok(!isProtectedTool("read", ["ask", "question", "todo"]));
  });
});

describe("isProtectedRead", () => {
  it("returns true for AGENTS.md", () => {
    assert.ok(isProtectedRead("AGENTS.md content here", ["AGENTS.md", ".opencode/"]));
  });

  it("returns true for .pi/", () => {
    assert.ok(isProtectedRead(".pi/settings.json content", ["AGENTS.md", ".pi/"]));
  });

  it("returns true with leading whitespace", () => {
    assert.ok(isProtectedRead("  .opencode/config", ["AGENTS.md", ".opencode/"]));
  });

  it("returns false for other content", () => {
    assert.ok(!isProtectedRead("src/main.ts content", ["AGENTS.md", ".opencode/"]));
  });
});

describe("getToolOutput", () => {
  it("returns output for completed tool", () => {
    assert.equal(getToolOutput(toolPart("bash", "hello world")), "hello world");
  });

  it("returns error for error tool", () => {
    assert.equal(getToolOutput(errorPart("bash", "something went wrong")), "something went wrong");
  });

  it("returns null for non-tool part", () => {
    assert.equal(getToolOutput({ type: "text", text: "hello" }), null);
  });

  it("returns null for pending tool", () => {
    const part: ShakePart = { type: "tool", tool: "bash", state: { status: "pending" } };
    assert.equal(getToolOutput(part), null);
  });
});

describe("getToolName/getCallID", () => {
  it("returns tool name and call ID", () => {
    const part = toolPart("bash", "x");
    assert.equal(getToolName(part), "bash");
    assert.equal(getCallID(part), "c-bash");
  });

  it("returns null for non-tool", () => {
    const part: ShakePart = { type: "text", text: "hi" };
    assert.equal(getToolName(part), null);
    assert.equal(getCallID(part), null);
  });
});

describe("scanBlocks", () => {
  it("finds triple-backtick code blocks", () => {
    const text = "Some text\n```python\nprint('hello')\n```\nMore text";
    const spans = scanBlocks(text, 0);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].label, "python");
    assert.ok(text.slice(spans[0].start, spans[0].end).includes("print"));
  });

  it("finds tilde code blocks", () => {
    const spans = scanBlocks("Text\n~~~javascript\nconst x = 1;\n~~~\nEnd", 0);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].label, "javascript");
  });

  it("finds XML-like tags", () => {
    const text = "Before\n<analysis>This is some analysis content that is reasonably long.</analysis>\nAfter";
    const spans = scanBlocks(text, 0);
    assert.ok(spans.length >= 1);
    assert.equal(spans[0].label, "analysis");
  });

  it("respects minTokens threshold", () => {
    assert.equal(scanBlocks("Text\n```\nshort\n```\nEnd", 1000).length, 0);
  });

  it("handles empty text and plain text", () => {
    assert.equal(scanBlocks("", 0).length, 0);
    assert.equal(scanBlocks("Just plain text.", 0).length, 0);
  });
});

describe("replaceBlocks", () => {
  it("replaces blocks with placeholders", () => {
    const text = "Before\n```python\nprint('hello')\n```\nAfter";
    const spans = scanBlocks(text, 0);
    assert.equal(spans.length, 1);
    const { text: result, replacements } = replaceBlocks(text, spans);
    assert.ok(result.includes("[shaken python block ~"));
    assert.ok(!result.includes("print('hello')"));
    assert.equal(replacements.length, 1);
    assert.equal(replacements[0].label, "python");
  });

  it("returns original text when no spans", () => {
    const { text: result, replacements } = replaceBlocks("No blocks here", []);
    assert.equal(result, "No blocks here");
    assert.equal(replacements.length, 0);
  });

  it("preserves text before and after blocks", () => {
    const text = "ABC\n```\nblock content here that is long enough\n```\nXYZ";
    const { text: result } = replaceBlocks(text, scanBlocks(text, 0));
    assert.ok(result.startsWith("ABC"));
    assert.ok(result.includes("XYZ"));
  });
});

describe("computeSuffixTokens", () => {
  it("computes suffix tokens correctly", () => {
    const entries = [
      { parts: [{ type: "text", text: "hello" } as ShakePart] },
      { parts: [{ type: "text", text: "world" } as ShakePart] },
    ];
    const suffixes = computeSuffixTokens(entries);
    assert.equal(suffixes.length, 2);
    assert.equal(suffixes[1], 0);
    assert.ok(suffixes[0] > 0);
  });

  it("handles empty and single entries", () => {
    assert.equal(computeSuffixTokens([]).length, 0);
    const suffixes = computeSuffixTokens([{ parts: [{ type: "text", text: "only" } as ShakePart] }]);
    assert.equal(suffixes[0], 0);
  });

  it("includes tool output in token count", () => {
    const entries = [
      { parts: [{ type: "text", text: "q" } as ShakePart] },
      { parts: [toolPart("bash", "tool output here")] },
    ];
    assert.ok(computeSuffixTokens(entries)[0] > 0);
  });
});
