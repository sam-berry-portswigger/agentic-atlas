import test from "node:test";
import assert from "node:assert/strict";
import { generateStreamOverview } from "../server/stream-overview.js";
import {
  canonicalOverviewSchema,
  savedStreamFocus,
} from "../server/streams.js";

const input = {
  analysisVersion: "saved-catalogue",
  groups: [
    { id: 12, name: "Release scheduling", color: "#aabbcc", evidence: [1, 2] },
    { id: 27, name: "Build Atlas", color: "#ccbbaa", evidence: [3] },
  ],
  sources: [
    {
      id: "release-request",
      text: "Implement the scheduling change.",
      streamId: 12,
    },
    { id: "release-result", text: "The scheduling tests passed.", streamId: 12 },
    {
      id: "atlas-result",
      text: "The Atlas board now saves tasks.",
      streamId: 27,
    },
  ],
};
const valid = () => ({
  summary: "Today you verified scheduling and improved Atlas.",
  streams: {
    12: { text: "You verified the scheduling change [2].", sources: [2] },
    27: { text: "The Atlas board now saves tasks [3].", sources: [3] },
  },
});

test("overview schema fixes stream keys and restricts each stream to its own evidence", () => {
  const schema = canonicalOverviewSchema(input.groups).properties.streams;
  assert.deepEqual(schema.required, ["12", "27"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties[12].properties.sources.items.enum, [1, 2]);
  assert.deepEqual(schema.properties[27].properties.sources.items.enum, [3]);
});

test("one valid summary pass keeps evidence grouped and reuses canonical names and source identities", async () => {
  let calls = 0;
  const output = await generateStreamOverview(null, input, {
    period: "Today",
    scope: {},
    generate: async (db, system, prompt) => {
      calls++;
      const payload = JSON.parse(prompt);
      assert.equal(payload.evidence, undefined, "no shared flat evidence pool");
      assert.deepEqual(
        payload.streams[1].evidence.map((e) => e.source),
        [3],
      );
      return valid();
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(
    output.focus.map((f) => f.streamId),
    [12, 27],
  );
  assert.deepEqual(
    output.focus.map((f) => f.title),
    ["Release scheduling", "Build Atlas"],
  );
  assert.deepEqual(output.focus[1].sourceIds, ["atlas-result"]);
});

test("a mixed citation gets one bounded automatic correction instead of discarding the overview immediately", async () => {
  let calls = 0,
    retries = 0;
  const output = await generateStreamOverview(null, input, {
    onRetry: () => retries++,
    generate: async (db, system, prompt) => {
      calls++;
      const result = valid();
      if (calls === 1) result.streams[27].sources = [2];
      else
        assert.match(
          JSON.parse(prompt).validationError,
          /different work stream/,
        );
      return result;
    },
  });
  assert.equal(calls, 2);
  assert.equal(retries, 1);
  assert.deepEqual(output.focus[1].sourceIds, ["atlas-result"]);
  let attempts = 0;
  await assert.rejects(
    generateStreamOverview(null, input, {
      generate: async () => {
        attempts++;
        const result = valid();
        result.streams[27].sources = [2];
        return result;
      },
    }),
    /different work stream/,
  );
  assert.equal(
    attempts,
    2,
    "persistent invalid output is rejected, never stripped or relabelled",
  );
});

test("inline citations are checked too; missing, unknown and unsupported entries cannot be saved", () => {
  const result = valid();
  result.streams[27].text = "Scheduling passed [2].";
  assert.throws(
    () => savedStreamFocus(result, input, {}),
    /different work stream/,
  );
  result.streams[27].text = "The board works [3].";
  result.streams[27].sources = [];
  assert.deepEqual(
    savedStreamFocus(result, input, {})[1].sourceIds,
    ["atlas-result"],
    "valid inline evidence remains attached",
  );
  result.streams[27].text = "The board works.";
  assert.throws(
    () => savedStreamFocus(result, input, {}),
    /supporting evidence/,
  );
  result.streams[999] = { text: "An invented stream", sources: [3] };
  assert.throws(
    () => savedStreamFocus(result, input, {}),
    /unknown work stream/,
  );
  delete result.streams[999];
  delete result.streams[27];
  assert.throws(() => savedStreamFocus(result, input, {}), /omitted stream 27/);
});

test("cancellation after generation does not validate, retry or publish a summary", async () => {
  let stopped = false,
    retries = 0;
  const output = await generateStreamOverview(null, input, {
    isStopped: () => stopped,
    onRetry: () => retries++,
    generate: async () => {
      stopped = true;
      return {};
    },
  });
  assert.equal(output, null);
  assert.equal(retries, 0);
});
