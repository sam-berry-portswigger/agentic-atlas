import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { startNDJSON } from "../server/http-stream.js";

test("NDJSON delivers a partial response before generation completes", async () => {
  let finish;
  const server = http.createServer((_req, res) => {
    startNDJSON(res);
    res.write(JSON.stringify({ event: "summary", text: "Partial" }) + "\n");
    finish = () =>
      res.end(
        JSON.stringify({
          event: "done",
          summary: "Partial response completed",
        }) + "\n",
      );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    assert.match(response.headers.get("cache-control"), /no-transform/);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(first.value)), {
      event: "summary",
      text: "Partial",
    });
    finish();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    assert.equal(JSON.parse(rest).event, "done");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
