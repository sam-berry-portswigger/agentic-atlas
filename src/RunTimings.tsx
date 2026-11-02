import { useEffect, useRef, useState } from "react";

export type TimingData = {
  elapsedMs: number;
  complete: boolean;
  stages: { label: string; elapsedMs: number; active: boolean }[];
  models: {
    label: string;
    model?: string;
    elapsedMs: number;
    firstTokenMs?: number;
    loadMs?: number;
    promptMs?: number;
    generationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    tokensPerSecond?: number;
    failed?: boolean;
  }[];
};
const seconds = (ms: number, live = false) =>
  live
    ? `${Math.floor(ms / 1000)}s`
    : ms < 100
      ? `${Math.round(ms)}ms`
      : `${(ms / 1000).toFixed(1)}s`;

export default function RunTimings({
  data,
  running = false,
}: {
  data?: TimingData;
  running?: boolean;
}) {
  const received = useRef(performance.now());
  const [now, setNow] = useState(received.current);
  // Overview polling can deliver the same worker snapshot repeatedly while a
  // model runs. Preserve its receipt time so the live clock doesn't reset.
  const snapshotKey = JSON.stringify(data);
  useEffect(() => {
    received.current = performance.now();
    setNow(received.current);
    if (!running || !data || data.complete) return;
    const timer = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(timer);
  }, [snapshotKey, running]);
  if (!data) return null;
  const extra =
    running && !data.complete ? Math.max(0, now - received.current) : 0;
  const total = data.elapsedMs + extra;
  const live = running && !data.complete;
  return (
    <details className="run-timings">
      <summary>
        Timing · {seconds(total, live)}
        {running && data.stages.some((stage) => stage.active) && (
          <span> · {data.stages.find((stage) => stage.active)?.label}</span>
        )}
      </summary>
      <div className="timing-stages">
        {data.stages.map((stage, i) => {
          const elapsed = stage.elapsedMs + (stage.active ? extra : 0);
          return (
            <div className="timing-stage" key={i}>
              <span>
                {stage.label}
                {stage.active && running ? "…" : ""}
              </span>
              <span className="timing-bar" aria-hidden="true">
                <i
                  style={{
                    width: `${Math.min(100, (elapsed / Math.max(1, total)) * 100)}%`,
                  }}
                />
              </span>
              <span>{seconds(elapsed, live && stage.active)}</span>
            </div>
          );
        })}
      </div>
      {data.models.map((model, i) => (
        <div className="timing-model" key={i}>
          <strong>
            {model.label}
            {data.models.length > 1 ? ` · call ${i + 1}` : ""} ·{" "}
            {seconds(model.elapsedMs)}
            {model.failed ? " · Failed attempt" : ""}
          </strong>
          {model.model && (
            <span className="timing-model-name">{model.model}</span>
          )}
          <dl>
            {(
              [
                [
                  "Model loading",
                  model.loadMs !== undefined ? seconds(model.loadMs) : null,
                ],
                [
                  "Prompt processing",
                  model.promptMs !== undefined ? seconds(model.promptMs) : null,
                ],
                [
                  "Token generation",
                  model.generationMs !== undefined
                    ? seconds(model.generationMs)
                    : null,
                ],
                [
                  "First token",
                  model.firstTokenMs !== undefined
                    ? seconds(model.firstTokenMs)
                    : null,
                ],
                ["Input tokens", model.inputTokens?.toLocaleString()],
                ["Output tokens", model.outputTokens?.toLocaleString()],
                [
                  "Generation speed",
                  model.tokensPerSecond !== undefined
                    ? `${model.tokensPerSecond.toFixed(1)} tokens/s`
                    : null,
                ],
              ] as [string, string | null | undefined][]
            )
              .filter(([, value]) => value != null)
              .map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
          </dl>
          {model.loadMs === undefined &&
            model.promptMs === undefined &&
            model.generationMs === undefined && (
              <p>This runner did not report internal model timings.</p>
            )}
        </div>
      ))}
      <p className="timing-note">
        Server processing time. Model details are included in the generation
        stage; Ollama may also spend time waiting between steps.
      </p>
    </details>
  );
}
