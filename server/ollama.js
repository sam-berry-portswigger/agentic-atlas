import { readNDJSON } from "../shared/stream.js";
import { measureInference } from "./timings.js";
// Loopback only. No provider API keys or remote inference endpoints.
const base = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const url = new URL(base);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  !["http:", "https:"].includes(url.protocol)
)
  throw new Error("OLLAMA_URL must use a loopback host.");
export async function ollama(route, body, timeout = 180000, signal) {
  let response;
  try {
    response = await fetch(`${base}/api/${route}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout),
    });
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(
      `Cannot reach local Ollama. Run ollama serve, then retry. (${error.message})`,
    );
  }
  const data = await response.json();
  if (!response.ok || data.error)
    throw new Error(data.error || `Ollama returned ${response.status}`);
  return data;
}
export async function ollamaStream(body, onToken, signal) {
  const response = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(180000)])
      : AbortSignal.timeout(180000),
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || `Ollama returned ${response.status}`);
  }
  if (!response.body)
    throw new Error("The local model returned no response stream.");
  let text = "",
    last = {};
  await readNDJSON(response.body, (message) => {
    if (message.error) throw new Error(message.error);
    last = message;
    if (message.response) {
      text += message.response;
      onToken(text);
    }
  });
  return { ...last, response: text };
}
export function documentInput(model, text, title = "") {
  if (model.startsWith("embeddinggemma"))
    return `title: ${title} | text: ${text}`;
  if (model.startsWith("nomic-embed-text")) return `search_document: ${text}`;
  return text;
}
export function queryInput(model, text) {
  if (model.startsWith("embeddinggemma"))
    return `task: search result | query: ${text}`;
  if (model.startsWith("nomic-embed-text")) return `search_query: ${text}`;
  if (model.startsWith("qwen3-embedding"))
    return `Instruct: Given a query, retrieve relevant conversation excerpts\nQuery: ${text}`;
  return text;
}
export async function generate(
  model,
  system,
  prompt,
  tokens = 600,
  signal,
  onMetrics,
) {
  const result = await measureInference(
    () =>
      ollama(
        "generate",
        {
          model,
          system,
          prompt,
          think: false,
          stream: false,
          keep_alive: "15m",
          options: { temperature: 0.2, num_ctx: 8192, num_predict: tokens },
        },
        180000,
        signal,
      ),
    onMetrics,
    model,
  );
  const text = result.response?.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!text)
    throw new Error(
      "The local model returned no text. Try another generation model in settings.",
    );
  return text;
}
