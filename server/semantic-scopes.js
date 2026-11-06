import { createHash } from "node:crypto";
import { getConfig, normalize } from "./db.js";
import { ollama, documentInput } from "./ollama.js";
import { isFallback } from "./semantic-policy.js";

// Stream scope is a semantic check on legacy examples, not a keyword rule.
export async function embedStreamScopes(db, topics, { signal } = {}) {
  const model = getConfig(db).embeddingModel;
  const vectors = new Map(),
    pending = [];
  for (const topic of topics.filter((t) => !isFallback(t))) {
    const key =
      "stream-scope-v1:" +
      createHash("sha256")
        .update(JSON.stringify([model, topic.name, topic.description]))
        .digest("hex");
    const cached = db
      .prepare("SELECT data FROM analysis_name_cache WHERE key=?")
      .get(key);
    if (cached) vectors.set(topic.id, JSON.parse(cached.data));
    else pending.push({ topic, key });
  }
  if (pending.length) {
    const response = await ollama(
      "embed",
      {
        model,
        input: pending.map(({ topic }) =>
          documentInput(model, topic.description, topic.name),
        ),
        keep_alive: "10m",
      },
      180000,
      signal,
    );
    if (
      response.embeddings?.length !== pending.length ||
      response.embeddings.some(
        (v) => !v.length || v.some((n) => !Number.isFinite(n)),
      )
    )
      throw Error("The local model returned invalid stream-scope embeddings.");
    const put = db.prepare(
      "INSERT OR REPLACE INTO analysis_name_cache VALUES(?,?)",
    );
    pending.forEach(({ topic, key }, i) => {
      const vector = Array.from(normalize(response.embeddings[i]));
      vectors.set(topic.id, vector);
      put.run(key, JSON.stringify(vector));
    });
  }
  return vectors;
}
