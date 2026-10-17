import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it } from "node:test";

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "hooks",
  "sanitize-read-session.mjs",
);
// Obviously synthetic, schema-valid target. The hook only pattern-matches
// /^sess_[A-Za-z0-9._-]+$/, so the concrete id carries no meaning for any
// assertion here.
const SESSION_ID = "sess_test_target";
const PLACEHOLDER_ATTACHMENT = {
  inputId: "placeholder",
  messageId: "placeholder",
  index: 0,
};

// Runs the hook as a real child process over stdin/stdout, the way the host does.
function runHook(stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

async function updatedInputFor(toolInput) {
  const { code, stdout, stderr } = await runHook(
    JSON.stringify({ tool_name: "ReadSessionContext", tool_input: toolInput }),
  );
  assert.equal(code, 0, `hook exited ${code}: ${stderr}`);
  assert.equal(stderr, "", "hook must not write to stderr");
  if (stdout === "") return undefined;
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  return parsed.hookSpecificOutput.updatedInput;
}

describe("sanitize-read-session: deletes the illegal attachment only", () => {
  it("removes attachment from a relevant-strategy call and keeps every other field", async () => {
    const updated = await updatedInputFor({
      sessionId: SESSION_ID,
      strategy: "relevant",
      query: "what changed in the routing layer?",
      maxTokens: 8000,
      attachment: PLACEHOLDER_ATTACHMENT,
    });
    assert.deepEqual(updated, {
      sessionId: SESSION_ID,
      strategy: "relevant",
      query: "what changed in the routing layer?",
      maxTokens: 8000,
    });
    assert.equal("attachment" in updated, false);
  });

  it("removes attachment from a handoff-strategy call", async () => {
    const updated = await updatedInputFor({
      sessionId: SESSION_ID,
      strategy: "handoff",
      query: "current objective and next steps",
      attachment: PLACEHOLDER_ATTACHMENT,
    });
    assert.deepEqual(updated, {
      sessionId: SESSION_ID,
      strategy: "handoff",
      query: "current objective and next steps",
    });
  });

  it("removes attachment when strategy is omitted, applying the documented relevant default", async () => {
    const updated = await updatedInputFor({
      sessionId: SESSION_ID,
      query: "focused question",
      attachment: PLACEHOLDER_ATTACHMENT,
    });
    assert.deepEqual(updated, { sessionId: SESSION_ID, query: "focused question" });
  });

  it("accepts both tool_name/tool_input and toolName/toolInput aliases", async () => {
    const { code, stdout } = await runHook(JSON.stringify({
      toolName: "ReadSessionContext",
      toolInput: {
        sessionId: SESSION_ID,
        strategy: "relevant",
        query: "alias form",
        attachment: PLACEHOLDER_ATTACHMENT,
      },
    }));
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout).hookSpecificOutput.updatedInput, {
      sessionId: SESSION_ID,
      strategy: "relevant",
      query: "alias form",
    });
  });
});

describe("sanitize-read-session: preserves positive parameters", () => {
  it("keeps a positive pagination cursor alongside the deletion", async () => {
    const updated = await updatedInputFor({
      sessionId: SESSION_ID,
      strategy: "relevant",
      query: "later page",
      cursor: 120,
      attachment: PLACEHOLDER_ATTACHMENT,
    });
    assert.equal(updated.cursor, 120);
  });

  it("keeps cursor 0, which is a legal first-page offset", async () => {
    const updated = await updatedInputFor({
      sessionId: SESSION_ID,
      strategy: "relevant",
      query: "first page",
      cursor: 0,
      attachment: PLACEHOLDER_ATTACHMENT,
    });
    assert.equal(updated.cursor, 0, "cursor 0 must not be treated as a placeholder");
  });

  it("keeps maxTokens and cursor untouched", async () => {
    const updated = await updatedInputFor({
      sessionId: SESSION_ID,
      strategy: "relevant",
      query: "budget",
      maxTokens: 12000,
      cursor: 480,
      attachment: PLACEHOLDER_ATTACHMENT,
    });
    assert.equal(updated.maxTokens, 12000);
    assert.equal(updated.cursor, 480);
  });

  it("preserves unicode in query and other string fields", async () => {
    const query = "路由层改了什么？— 只看 src/router.ts 的 diff ✅";
    const updated = await updatedInputFor({
      sessionId: SESSION_ID,
      strategy: "relevant",
      query,
      attachment: { messageId: "om_中文🎯" },
    });
    assert.equal(updated.query, query);
  });

  it("delivers a max-length unicode query in full over a piped stdout", async () => {
    // Verifies the payload arrives complete over a pipe at the schema maximum.
    // It does not reproduce any earlier truncation: the same assertion passes
    // with the pre-0.1.3 early exit, so this guards delivery, it is not proof
    // that a failure existed.
    //
    // The schema cap is 4000 UTF-16 code units, not code points, and emoji are
    // surrogate pairs — so the string is grown by whole characters until the
    // next one would overflow, then padded with a 1-unit character. No surrogate
    // pair is ever split, so the result is exactly 4000 units and schema-legal.
    const chars = Array.from("路由层改动✅🎯—");
    let query = "";
    for (let i = 0; ; i++) {
      const ch = chars[i % chars.length];
      if (query.length + ch.length > 4000) break;
      query += ch;
    }
    while (query.length < 4000) query += "路";
    assert.equal(query.length, 4000, "must be exactly the 4000-unit schema maximum");
    assert.match(query, /🎯/, "keeps a surrogate pair");
    assert.match(query, /路/, "keeps a 1-unit CJK character");

    const { code, stdout, stderr } = await runHook(JSON.stringify({
      tool_name: "ReadSessionContext",
      tool_input: {
        sessionId: SESSION_ID,
        strategy: "relevant",
        query,
        attachment: PLACEHOLDER_ATTACHMENT,
      },
    }));

    assert.equal(code, 0, `hook exited ${code}: ${stderr}`);
    assert.equal(stderr, "");
    const parsed = JSON.parse(stdout);
    const updated = parsed.hookSpecificOutput.updatedInput;
    assert.equal(updated.query, query, "query must arrive byte-complete, not truncated");
    assert.equal("attachment" in updated, false);
    assert.equal(updated.query.length, 4000);
  });
});

describe("sanitize-read-session: leaves valid input alone", () => {
  it("does not touch a valid relevant call without attachment", async () => {
    const updated = await updatedInputFor({
      sessionId: SESSION_ID,
      strategy: "relevant",
      query: "already valid",
      maxTokens: 6000,
    });
    assert.equal(updated, undefined);
  });

  it("does not touch a valid handoff call with cursor", async () => {
    const updated = await updatedInputFor({
      sessionId: SESSION_ID,
      strategy: "handoff",
      query: "continuation",
      cursor: 240,
    });
    assert.equal(updated, undefined);
  });

  it("does not touch another tool", async () => {
    const { code, stdout } = await runHook(JSON.stringify({
      tool_name: "Bash",
      tool_input: { sessionId: SESSION_ID, attachment: PLACEHOLDER_ATTACHMENT },
    }));
    assert.equal(code, 0);
    assert.equal(stdout, "");
  });
});

describe("sanitize-read-session: topic and cross-session calls are untouched", () => {
  it("keeps attachment on a topic call against the current session", async () => {
    const attachment = { messageId: "om_real", index: 2 };
    const updated = await updatedInputFor({
      sessionId: "current",
      strategy: "topic",
      query: "archived discussion",
      attachment,
    });
    assert.equal(updated, undefined);
  });

  it("keeps attachment on a topic call that omits sessionId", async () => {
    const updated = await updatedInputFor({
      strategy: "topic",
      query: "archived discussion",
      attachment: { messageId: "om_real" },
    });
    assert.equal(updated, undefined);
  });

  it("keeps attachment on a topic call targeting an explicit sess_* id", async () => {
    const updated = await updatedInputFor({
      sessionId: SESSION_ID,
      strategy: "topic",
      query: "cross-session topic",
      attachment: { messageId: "om_real" },
    });
    assert.equal(updated, undefined, "topic stays byte-semantically untouched even for sess_* targets");
  });
});

describe("sanitize-read-session: pass-through keeps native failures native", () => {
  it("passes through sessionId current on a non-topic strategy", async () => {
    const updated = await updatedInputFor({
      sessionId: "current",
      strategy: "relevant",
      query: "no explicit target",
      attachment: PLACEHOLDER_ATTACHMENT,
    });
    assert.equal(updated, undefined, "must not paper over the missing sess_* target");
  });

  it("passes through a missing sessionId on a non-topic strategy", async () => {
    const updated = await updatedInputFor({
      strategy: "relevant",
      query: "no session at all",
      attachment: PLACEHOLDER_ATTACHMENT,
    });
    assert.equal(updated, undefined);
  });

  it("passes through an unknown strategy value", async () => {
    for (const strategy of ["summarize", "Relevant", "", null, 7]) {
      const updated = await updatedInputFor({
        sessionId: SESSION_ID,
        strategy,
        query: "unknown strategy",
        attachment: PLACEHOLDER_ATTACHMENT,
      });
      assert.equal(updated, undefined, `strategy ${JSON.stringify(strategy)} must pass through`);
    }
  });

  it("passes through a malformed session id", async () => {
    for (const sessionId of ["sess_", "not-a-session", "sess bad", "sess_../etc"]) {
      const updated = await updatedInputFor({
        sessionId,
        strategy: "relevant",
        query: "malformed target",
        attachment: PLACEHOLDER_ATTACHMENT,
      });
      assert.equal(updated, undefined, `sessionId ${JSON.stringify(sessionId)} must pass through`);
    }
  });

  it("passes through invalid JSON", async () => {
    const { code, stdout, stderr } = await runHook("{not json");
    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.equal(stderr, "");
  });

  it("passes through a non-object event payload", async () => {
    for (const payload of ["[]", '"string"', "42", "null"]) {
      const { code, stdout } = await runHook(payload);
      assert.equal(code, 0);
      assert.equal(stdout, "");
    }
  });

  it("passes through an array tool input", async () => {
    const { code, stdout } = await runHook(JSON.stringify({
      tool_name: "ReadSessionContext",
      tool_input: [{ sessionId: SESSION_ID, attachment: PLACEHOLDER_ATTACHMENT }],
    }));
    assert.equal(code, 0);
    assert.equal(stdout, "");
  });

  it("passes through a missing or non-object tool input", async () => {
    for (const tool_input of [undefined, null, "text", 5]) {
      const { code, stdout } = await runHook(JSON.stringify({
        tool_name: "ReadSessionContext",
        tool_input,
      }));
      assert.equal(code, 0);
      assert.equal(stdout, "");
    }
  });

  it("passes through an empty payload", async () => {
    const { code, stdout } = await runHook("");
    assert.equal(code, 0);
    assert.equal(stdout, "");
  });
});

describe("sanitize-read-session: never invents input", () => {
  it("adds no sessionId, strategy, query, cursor, or maxTokens", async () => {
    const updated = await updatedInputFor({
      sessionId: SESSION_ID,
      attachment: PLACEHOLDER_ATTACHMENT,
    });
    assert.deepEqual(Object.keys(updated).sort(), ["sessionId"]);
    assert.equal("query" in updated, false, "query must not be fabricated");
    assert.equal("strategy" in updated, false, "strategy must not be fabricated");
    assert.equal("cursor" in updated, false);
    assert.equal("maxTokens" in updated, false);
    assert.equal(updated.sessionId, SESSION_ID, "sessionId must be the real target");
  });

  it("drops exactly one key and copies the rest by value", async () => {
    const attachment = { messageId: "om_x", inputId: "in_y", index: 7 };
    const input = {
      sessionId: SESSION_ID,
      strategy: "relevant",
      query: "count keys",
      cursor: 30,
      maxTokens: 7000,
      attachment,
    };
    const updated = await updatedInputFor(input);
    const before = Object.keys(input).sort();
    const after = Object.keys(updated).sort();
    assert.deepEqual(after, before.filter(key => key !== "attachment"));
    for (const key of after) assert.equal(updated[key], input[key]);
  });
});
