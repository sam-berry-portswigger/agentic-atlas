import test from "node:test";
import assert from "node:assert/strict";
import { sessionOpenLink } from "../shared/session-links.js";
const id = "11111111-1111-4111-8111-111111111111",
  host = "local_22222222-2222-4222-8222-222222222222";
test("open actions use recorded desktop IDs, resume CLI histories, and keep Codex links", () => {
  assert.equal(
    sessionOpenLink({ provider: "claude", nativeId: id, hostSessionId: host })
      .href,
    "claude://code/continue?session=" + host,
  );
  assert.equal(
    sessionOpenLink({ provider: "claude", nativeId: id }).href,
    "claude://resume?session=" + id,
  );
  assert.equal(
    sessionOpenLink({ provider: "codex", nativeId: id }).href,
    "codex://threads/" + id,
  );
});
test("Claude subagent traces open their actual parent conversation and invalid IDs cannot form links", () => {
  const parent = { id, nativeId: id, provider: "claude", hostSessionId: host };
  const child = {
    id: id + ":agent-one",
    nativeId: "agent-one",
    provider: "claude",
    parent: id,
  };
  const link = sessionOpenLink(child, new Map([[id, parent]]));
  assert.equal(link.href, "claude://code/continue?session=" + host);
  assert.equal(link.parent, true);
  assert.equal(
    sessionOpenLink({ provider: "claude", nativeId: "bad?prompt=execute" })
      .href,
    null,
  );
  assert.equal(
    sessionOpenLink({
      provider: "claude",
      nativeId: id,
      hostSessionId: "javascript:bad",
    }).href,
    "claude://resume?session=" + id,
  );
});
