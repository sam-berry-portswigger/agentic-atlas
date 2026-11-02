// Wall-clock stages are exclusive. Model statistics are a breakdown inside a
// generation stage, not extra time to add to the total.
export function createTimings(
  onUpdate = () => {},
  clock = () => performance.now(),
) {
  const started = clock();
  const stages = [],
    models = [];
  let ended = null;
  const snapshot = () => {
    const now = ended ?? clock();
    return {
      elapsedMs: Math.round(now - started),
      complete: ended !== null,
      stages: stages.map(({ label, start, end }) => ({
        label,
        elapsedMs: Math.round((end ?? now) - start),
        active: end === undefined,
      })),
      models: [...models],
    };
  };
  return {
    snapshot,
    begin(label) {
      if (ended !== null) return;
      if (stages.at(-1)?.label === label) return;
      const now = clock();
      if (stages.length) stages.at(-1).end = now;
      stages.push({ label, start: now });
      onUpdate(snapshot());
    },
    model(metrics) {
      models.push(metrics);
      onUpdate(snapshot());
    },
    finish() {
      if (ended === null) {
        ended = clock();
        if (stages.length) stages.at(-1).end = ended;
        onUpdate(snapshot());
      }
      return snapshot();
    },
  };
}

export function indexTiming(timing, message) {
  const label = {
    importing: "Import changed sessions",
    embedding: "Embed new conversation text",
  }[message.detail];
  if (label) timing.begin(label);
}

// Ollama durations are nanoseconds. Some MLX runners omit these counters; leave
// absent values absent instead of reporting a misleading zero or fabricated rate.
export function modelMetrics(result, elapsedMs, firstTokenMs, failed = false) {
  const ms = (key) =>
    typeof result?.[key] === "number" && result[key] >= 0
      ? result[key] / 1e6
      : undefined;
  const count = (key) =>
    typeof result?.[key] === "number" && result[key] >= 0
      ? result[key]
      : undefined;
  const generationMs = ms("eval_duration");
  const outputTokens = count("eval_count");
  return {
    model: result?.model,
    elapsedMs: Math.round(elapsedMs),
    firstTokenMs:
      firstTokenMs === undefined ? undefined : Math.round(firstTokenMs),
    loadMs: ms("load_duration"),
    promptMs: ms("prompt_eval_duration"),
    generationMs,
    inputTokens: count("prompt_eval_count"),
    outputTokens,
    tokensPerSecond:
      generationMs > 0 && outputTokens !== undefined
        ? (outputTokens * 1000) / generationMs
        : undefined,
    failed,
  };
}

export async function measureInference(run, onMetrics, model) {
  const started = performance.now();
  let result,
    firstTokenMs,
    failed = true;
  try {
    result = await run(() => {
      firstTokenMs ??= performance.now() - started;
    });
    failed = false;
    return result;
  } finally {
    onMetrics?.({
      ...modelMetrics(
        result,
        performance.now() - started,
        firstTokenMs,
        failed,
      ),
      model: result?.model || model,
    });
  }
}
