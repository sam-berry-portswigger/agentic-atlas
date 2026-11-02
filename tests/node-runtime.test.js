import test from "node:test";
import assert from "node:assert/strict";
import { stableNodeCommand } from "../server/node-runtime.js";

test("setup uses an executable stable Homebrew link to the current runtime", () => {
  const current = "/opt/homebrew/Cellar/node/26.13.0/bin/node";
  assert.equal(
    stableNodeCommand(current, {
      resolve: () => current,
      access: () => {},
    }),
    "/opt/homebrew/opt/node/bin/node",
  );
  const versioned = "/usr/local/Cellar/node@24/24.10.0/bin/node";
  assert.equal(
    stableNodeCommand(versioned, {
      resolve: () => versioned,
      access: () => {},
    }),
    "/usr/local/opt/node@24/bin/node",
  );
});
test("setup never switches to a different or inaccessible runtime", () => {
  const current = "/opt/homebrew/Cellar/node/26.13.0/bin/node";
  assert.equal(
    stableNodeCommand(current, {
      resolve: (p) => (p === current ? current : "/different/node"),
      access: () => {},
    }),
    current,
  );
  assert.equal(
    stableNodeCommand(current, {
      resolve: () => current,
      access: () => {
        throw Error("not executable");
      },
    }),
    current,
  );
  assert.equal(stableNodeCommand("/usr/bin/node"), "/usr/bin/node");
});
test("a still-running process whose Cellar binary was removed exports a compatible stable successor", () => {
  const old = "/opt/homebrew/Cellar/node/26.12.1/bin/node";
  const io = {
    resolve: (p) => {
      if (p === old) throw Error("removed");
      return "/opt/homebrew/Cellar/node/26.13.0/bin/node";
    },
    access: () => {},
    version: () => "26.13.0",
  };
  assert.equal(stableNodeCommand(old, io), "/opt/homebrew/opt/node/bin/node");
  assert.equal(stableNodeCommand(old, { ...io, version: () => "20.0.0" }), old);
});
