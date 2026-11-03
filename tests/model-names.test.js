import test from "node:test";
import assert from "node:assert/strict";
import { sameModelName, preserveModelAlias } from "../shared/model-names.js";

test("default-tag aliases retain the configured spelling, while real model changes remain distinct", () => {
  assert.equal(sameModelName("embeddinggemma", "embeddinggemma:latest"), true);
  assert.equal(
    preserveModelAlias("embeddinggemma:latest", "embeddinggemma"),
    "embeddinggemma",
  );
  assert.equal(
    preserveModelAlias("embeddinggemma", "embeddinggemma:latest"),
    "embeddinggemma:latest",
  );
  assert.equal(
    preserveModelAlias("embeddinggemma:v2", "embeddinggemma"),
    "embeddinggemma:v2",
  );
  assert.equal(
    preserveModelAlias("other:latest", "embeddinggemma"),
    "other:latest",
  );
  assert.equal(
    preserveModelAlias("embeddinggemma:latest", undefined),
    "embeddinggemma:latest",
  );
  assert.equal(
    sameModelName("server:11434/team/model", "server:11434/team/model:latest"),
    true,
  );
});
