import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Import the extension factory directly (no Pi runtime needed)
import shakeExtension from "../extensions/shake.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type AnyHandler = (...args: any[]) => Promise<unknown>;

function makeHarness(branchMessages: Array<Record<string, unknown>> = []) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, { execute: AnyHandler }>();
  const commands = new Map<string, { handler: AnyHandler }>();
  const notices: string[] = [];
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shake-ext-"));
  const sessionId = "sess-test";
  const pi = {
    on: (name: string, h: Handler) => {
      handlers.set(name, h);
      return () => {};
    },
    registerTool: (t: { name: string; execute: AnyHandler }) => {
      tools.set(t.name, t);
    },
    registerCommand: (name: string, opts: { handler: AnyHandler }) => {
      commands.set(name, opts);
    },
    getSettings: () => ({}),
  };
  const ctx = {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branchMessages.map((message, i) => ({ type: "message", id: `e${i}`, message })),
    },
    ui: { notify: (msg: string) => void notices.push(msg) },
  };
  return { handlers, tools, commands, notices, cwd, sessionId, pi, ctx };
}

const big = "output line ".repeat(500);

describe("extension wiring", () => {
  it("registers context handler, shake_context tool and /shake command", () => {
    const h = makeHarness();
    shakeExtension(h.pi as never);
    assert.ok(h.handlers.has("context"));
    assert.ok(h.tools.has("shake_context"));
    assert.ok(h.commands.has("shake"));
  });

  it("auto-shakes old tool output on context event (conservative)", async () => {
    const h = makeHarness();
    shakeExtension(h.pi as never);
    const messages: Array<Record<string, unknown>> = [
      { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: big }], isError: false },
    ];
    // Push the old output out of the 32k protect window with trailing filler
    // (~500 tokens each; 70 ≈ 35k tokens of suffix).
    for (let i = 0; i < 70; i++) {
      messages.push({ role: "user", content: `filler message number ${i} ` + "x".repeat(2000) });
    }
    const handler = h.handlers.get("context")!;
    const result = (await handler({ messages }, h.ctx)) as { messages: unknown[] } | undefined;
    assert.ok(result?.messages, "handler should return mutated messages");
    const first = messages[0] as { content: Array<{ text: string }> };
    assert.ok(first.content[0].text.startsWith("[shaken"), `got: ${first.content[0].text.slice(0, 60)}`);
    assert.ok(h.notices.some((n) => n.includes("Context Shake")));
  });

  it("leaves lean context untouched and stays silent", async () => {
    const h = makeHarness();
    shakeExtension(h.pi as never);
    const messages = [{ role: "user", content: "hello" }];
    const result = (await h.handlers.get("context")!({ messages }, h.ctx)) as unknown;
    assert.equal(result, undefined);
    assert.equal(h.notices.length, 0);
    assert.equal((messages[0] as { content: string }).content, "hello");
  });

  it("tool dry-runs, arms aggressive shake, writes artifact on next request", async () => {
    const branch = [
      { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: big }], isError: false },
    ];
    const h = makeHarness(branch);
    shakeExtension(h.pi as never);
    const tool = h.tools.get("shake_context")!;
    const res = (await tool.execute("t1", { mode: "elide", aggressive: true }, undefined, undefined, h.ctx)) as {
      content: Array<{ text: string }>;
    };
    assert.ok(res.content[0].text.includes("Shake armed"), `got: ${res.content[0].text}`);

    // Next request applies the armed shake with recover links + artifact file
    const live = [
      { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: big }], isError: false },
    ];
    await h.handlers.get("context")!({ messages: live }, h.ctx);
    const first = live[0] as { content: Array<{ text: string }> };
    assert.ok(first.content[0].text.includes("recover:"), `got: ${first.content[0].text.slice(0, 120)}`);
    const artifactPath = first.content[0].text.match(/recover: (\S+)#/)?.[1];
    assert.ok(artifactPath && fs.existsSync(artifactPath), "artifact file should exist");
    assert.ok(fs.readFileSync(artifactPath, "utf-8").includes("Shake Artifact"));
    assert.ok(fs.existsSync(path.join(h.cwd, ".pi", ".shake")));
  });

  it("/shake command notifies a summary", async () => {
    const branch = [
      { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: big }], isError: false },
    ];
    const h = makeHarness(branch);
    shakeExtension(h.pi as never);
    await h.commands.get("shake")!.handler("", h.ctx);
    assert.ok(h.notices.some((n) => n.includes("Shake armed") || n.includes("already lean")));
  });
});
