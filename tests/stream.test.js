import test from "node:test";
import assert from "node:assert/strict";
import {
  readNDJSON,
  partialJSONString,
  partialJSONArray,
} from "../shared/stream.js";

test("NDJSON accepts arbitrary byte splits, Unicode, multiple messages and an unterminated last line", async () => {
  const bytes = new TextEncoder().encode('{"text":"hi 🌿"}\n\n{"done":true}');
  const stream = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const messages = [];
  await readNDJSON(stream, (message) => messages.push(message));
  assert.deepEqual(messages, [{ text: "hi 🌿" }, { done: true }]);
});
test("partial answers decode escaped quotes and line breaks without exposing unfinished escapes", () => {
  const response = JSON.stringify({
    answer: 'You chose "SQLite".\nUse WAL. 🌿',
    findings: [],
  });
  let previous = "";
  for (let i = 0; i <= response.length; i++) {
    const text = partialJSONString(response.slice(0, i));
    assert.ok('You chose "SQLite".\nUse WAL. 🌿'.startsWith(text));
    assert.ok(text.startsWith(previous));
    previous = text;
  }
  assert.equal(previous, 'You chose "SQLite".\nUse WAL. 🌿');
  assert.equal(partialJSONString('{"answer":"line\\u00'), "line");
  assert.equal(partialJSONString('{"answer":"line\\nnext\\'), "line\nnext");
});
test("malformed stream frames fail rather than pretending the response completed", async () => {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode("{broken}\n"));
      c.close();
    },
  });
  await assert.rejects(
    readNDJSON(stream, () => {}),
    SyntaxError,
  );
});

test("findings stream as complete objects with quoted braces and escaped quotes intact", () => {
  const one = {
    text: "A {quoted} path",
    quote: 'He said "fixed".',
    status: "resolved",
  };
  const two = { text: "Still open", quote: "Needs a check.", status: "open" };
  const prefix = '{"findings":[' + JSON.stringify(one) + ",";
  assert.deepEqual(partialJSONArray(prefix + '{"text":"Still'), [one]);
  assert.deepEqual(partialJSONArray(prefix + JSON.stringify(two) + "]}"), [
    one,
    two,
  ]);
});
