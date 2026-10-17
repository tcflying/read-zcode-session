#!/usr/bin/env node
// PreToolUse sanitizer for ReadSessionContext.
//
// Deletes `attachment` only when the tool's own schema forbids it, so the call
// passes the handler's strategy check. Every other key is copied by value.
//
// Constraints the code cannot show:
// - Anything not recognized here is a silent no-op, so host validation stays
//   authoritative and its errors still surface.
// - stdin/stdout only: no file, DB, network, secret, or logging access.
// - Delete-only. Never adds, renames, or edits a value, and never supplies a
//   sessionId, strategy, or query the caller did not send.
const TOOL = "ReadSessionContext";
// Omitted strategy means the tool's documented default.
const DEFAULT_STRATEGY = "relevant";
// "topic" is excluded: attachment is legal there, and its target is the current
// session rather than an explicit sess_* one.
const SANITIZABLE_STRATEGIES = new Set(["relevant", "handoff"]);
const SESSION_ID = /^sess_[A-Za-z0-9._-]+$/;

function sanitize(toolInput) {
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return null;

  const strategy = toolInput.strategy === undefined ? DEFAULT_STRATEGY : toolInput.strategy;
  if (typeof strategy !== "string" || !SANITIZABLE_STRATEGIES.has(strategy)) return null;

  const sessionId = toolInput.sessionId;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;

  if (!("attachment" in toolInput)) return null;

  const cleaned = { ...toolInput };
  delete cleaned.attachment;
  return cleaned;
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { raw += chunk; });
process.stdin.on("end", () => {
  let event;
  try { event = JSON.parse(raw || "{}"); } catch { return; }
  if (!event || typeof event !== "object" || Array.isArray(event)) return;

  const tool = event.tool_name ?? event.toolName;
  if (tool !== TOOL) return;

  const cleaned = sanitize(event.tool_input ?? event.toolInput);
  if (!cleaned) return;

  // Exiting naturally lets Node drain a piped stdout; process.exit(0) here can
  // truncate the payload.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: cleaned,
    },
  }));
});
