import { getConfig } from "./db.js";
import { ollama, ollamaStream } from "./ollama.js";
import { measureInference } from "./timings.js";
const capabilities = new Map();
function structuredCapability(db, model) {
  if (capabilities.has(model)) return capabilities.get(model);
  const cached = db
    .prepare("SELECT data FROM analysis_name_cache WHERE key=?")
    .get("model-capability:structured-v1:" + model);
  const supported = cached ? JSON.parse(cached.data).supported !== false : true;
  capabilities.set(model, supported);
  return supported;
}
export async function jsonGenerate(
  db,
  system,
  prompt,
  format,
  tokens = 900,
  events = {},
) {
  const model = getConfig(db).generationModel;
  let structuredSupported = structuredCapability(db, model),
    attempts = 0;
  events.signal?.throwIfAborted();
  const request = {
    model,
    system:
      system +
      " Output only a JSON object, without Markdown fences. Required JSON schema: " +
      JSON.stringify(format),
    prompt,
    think: false,
    stream: false,
    keep_alive: "15m",
    options: { temperature: 0.1, num_ctx: 16384, num_predict: tokens },
  };
  const infer = (request) => {
    events.signal?.throwIfAborted();
    attempts++;
    events.onAttempt?.(attempts);
    return measureInference(
      async (firstToken) => {
        if (!events.onText)
          return ollama("generate", request, 180000, events.signal);
        events.onReset?.();
        return ollamaStream(
          request,
          (text) => {
            firstToken();
            events.onText(text);
          },
          events.signal,
        );
      },
      (metrics) =>
        events.onMetrics?.({
          ...metrics,
          attempt: attempts,
          promptCharacters: prompt.length,
        }),
      request.model,
    );
  };
  let result;
  try {
    result = await infer({
      ...request,
      ...(structuredSupported ? { format } : {}),
    });
  } catch (error) {
    events.signal?.throwIfAborted();
    if (
      !structuredSupported ||
      !/structured output|format.*(support|unavailable)|grammar|schema.*support/i.test(
        error.message,
      )
    )
      throw error;
    structuredSupported = false;
    capabilities.set(model, false);
    db.prepare(
      "INSERT OR REPLACE INTO analysis_name_cache(key,data) VALUES(?,?)",
    ).run(
      "model-capability:structured-v1:" + model,
      JSON.stringify({ supported: false }),
    );
    result = await infer(request);
  }
  const maxAttempts = events.maxAttempts ?? 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    events.signal?.throwIfAborted();
    const text =
      result.response?.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || "";
    try {
      return JSON.parse(
        text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
      );
    } catch {
      if (attempt === maxAttempts - 1)
        throw new Error(
          "The local model returned incomplete structured output. Retry to resume saved summaries.",
        );
      // Some MLX runners cannot enforce a schema. Give malformed output one bounded retry.
      result = await infer({
        ...request,
        ...(structuredSupported ? { format } : {}),
        system:
          request.system +
          "\nYour previous response could not be parsed. Return one complete, valid JSON object matching the schema. Keep every reason and quotation short, escape quotation marks within strings, and include every requested item. No commentary or Markdown.",
        options: {
          ...request.options,
          temperature: 0,
          num_predict: Math.max(tokens, 2000),
        },
      });
    }
  }
}
