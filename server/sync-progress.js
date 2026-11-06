import { randomUUID } from "node:crypto";

const terminal = new Set(["complete", "paused", "error"]);
const countable = new Set([
  "importing",
  "embedding",
  "projecting",
  "assigning",
]);

// A job snapshot stays small enough to poll without reading the archive. Counts
// come only from committed work; heartbeats update time, never invent progress.
export function createSyncProgress(publish, { clock = Date.now } = {}) {
  const started = clock(),
    id = randomUUID(),
    stages = [],
    models = [],
    warnings = [];
  let current = null,
    finished = false,
    lastProgress = started;
  const snapshot = () => {
    const now = clock();
    return {
      ...current,
      id,
      startedAt: new Date(started).toISOString(),
      updatedAt: new Date(now).toISOString(),
      lastProgressAt: new Date(lastProgress).toISOString(),
      elapsedMs: now - started,
      stageElapsedMs: stages.length ? now - stages.at(-1).started : 0,
      stages: stages.map(({ started, ended, ...stage }) => ({
        ...stage,
        elapsedMs: (ended ?? now) - started,
        complete: ended !== undefined,
      })),
      warnings: [...warnings],
      models: [...models],
    };
  };
  const emit = () => {
    const value = snapshot();
    publish(value);
    return value;
  };
  return {
    progress(phase, done = 0, total = 0, detail = "", extra = {}) {
      if (finished) return snapshot();
      if (phase === "warning") {
        if (detail && !warnings.includes(detail)) warnings.push(detail);
        if (warnings.length > 8) warnings.shift();
        lastProgress = clock();
        return current ? emit() : null;
      }
      const now = clock();
      if (
        phase === "complete" &&
        extra.assignmentsReady === true &&
        Array.isArray(extra.warnings)
      )
        warnings.length = 0;
      for (const item of extra.warnings || []) {
        const warning = typeof item === "string" ? item : item?.message;
        if (warning && !warnings.includes(warning)) warnings.push(warning);
      }
      if (extra.model && typeof extra.model === "object") {
        models.push(extra.model);
        if (models.length > 8) models.shift();
      }
      if (warnings.length > 8) warnings.splice(0, warnings.length - 8);
      if (phase !== current?.phase) {
        if (stages.length) stages.at(-1).ended = now;
        if (!terminal.has(phase)) {
          stages.push({ phase, started: now, done, total });
          if (stages.length > 16) stages.shift();
        }
      }
      if (!terminal.has(phase) && stages.length)
        Object.assign(stages.at(-1), { done, total });
      lastProgress = now;
      current = {
        ...current,
        ...extra,
        phase,
        done,
        total,
        detail,
        indeterminate:
          !terminal.has(phase) && (!countable.has(phase) || total <= 0),
      };
      finished = terminal.has(phase);
      return emit();
    },
    heartbeat() {
      if (current && !finished) return emit();
      return current ? snapshot() : null;
    },
  };
}
