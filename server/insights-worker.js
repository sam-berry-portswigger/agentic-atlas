import { readTopic } from "./topic.js";
import { saveSummary } from "./summary-cache.js";
import { parentPort, workerData } from "node:worker_threads";
import { openDb, getConfig } from "./db.js";
import { updateArchive } from "./archive-update.js";
import { updateCatalogue } from "./incremental-analysis.js";
import { catalogue } from "./analysis-store.js";
import { acquireIndexLock } from "./index-lock.js";
import { generateStreamOverview } from "./stream-overview.js";
import { createTimings, indexTiming } from "./timings.js";
import { fingerprint, insightKey } from "./insights.js";
import { overviewStreamContext } from "./streams.js";
const db = openDb(),
  scope = workerData.scope;
let stopped = false,
  phase = "starting",
  release;
parentPort.on("message", (message) => {
  if (message === "stop") stopped = true;
});
const send = (message) => {
  phase = message.phase || phase;
  parentPort.postMessage({ ...message, timings: timing.snapshot(), scope });
};
const timing = createTimings(() => send({ phase, done: 0, total: 1 })),
  started = Date.now();
try {
  timing.begin("Update session index");
  await updateArchive(
    db,
    (message) => {
      indexTiming(timing, message);
      send(message);
    },
    () => stopped,
  );
  if (!stopped) {
    release = acquireIndexLock();
    await updateCatalogue(db, {
      send: (phase, done, total, detail) =>
        send({ phase, done, total, detail }),
      isStopped: () => stopped,
    });
    release();
    release = null;
    timing.begin("Group and select context");
    send({ phase: "grouping", done: 0, total: 1 });
    const input = overviewStreamContext(db, scope);
    if (!input.groups.length)
      throw Error(
        "No analysed work-stream evidence in these dates. Sync sessions or choose a wider range.",
      );
    const signature = fingerprint(db, scope);
    timing.begin("Generate overview");
    send({ phase: "overview", done: 0, total: 1 });
    const inferenceStarted = Date.now();
    const generated = await generateStreamOverview(db, input, {
      scope,
      period: workerData.periodLabel,
      isStopped: () => stopped,
      onRetry: () =>
        send({
          phase: "overview",
          done: 0,
          total: 1,
          detail: "Correcting summary references",
        }),
      onMetrics: (metrics) =>
        timing.model({ ...metrics, label: "Stream overview" }),
    });
    if (!stopped) {
      timing.begin("Validate and prepare overview");
      const { result, focus } = generated;
      // The per-stream text from this one overview pass also serves its topic panel.
      for (const item of focus) {
        const group = input.groups.find((g) => g.id === item.streamId);
        const numbered = group.evidence.map((n) => ({
          number: n,
          row: input.sources[n - 1],
        }));
        const local = new Map(numbered.map((s, i) => [s.number, i + 1]));
        let summary = item.text.replace(
          /\[(\d+(?:\s*,\s*\d+)*)\]/g,
          (match, numbers) => {
            const refs = numbers
              .split(",")
              .map(Number)
              .map((n) => local.get(n))
              .filter(Boolean);
            return refs.length ? "[" + refs.join(", ") + "]" : "";
          },
        );
        if (!/\[\d+/.test(summary)) {
          const refs = numbered
            .map((s, i) => (item.sourceIds.includes(s.row.id) ? i + 1 : null))
            .filter(Boolean);
          summary += " [" + refs.join(", ") + "]";
        }
        const topic = readTopic(db, scope, {
          kind: "stream",
          streamId: item.streamId,
        });
        saveSummary(db, topic, getConfig(db).generationModel, {
          summary,
          selection: topic.summarySelection,
          sources: numbered.map((s) => s.row),
        });
      }
      const data = {
        scope,
        periodLabel: workerData.periodLabel,
        total: input.streams.reduce((n, s) => n + s.passages, 0),
        topics: catalogue(db).map((t) => ({
          ...t,
          sources: [],
          sourceIds: [],
        })),
        analysisVersion: input.analysisVersion,
        overview: { summary: result.summary.trim().slice(0, 1600), focus },
        generatedAt: new Date().toISOString(),
        model: getConfig(db).generationModel,
        method: "shared-stream-summary-v1",
        elapsed: Date.now() - started,
        inferenceElapsed: Date.now() - inferenceStarted,
        timings: timing.finish(),
      };
      db.prepare("INSERT OR REPLACE INTO insights VALUES(?,?,?)").run(
        insightKey(scope),
        signature,
        JSON.stringify(data),
      );
    }
  }
  timing.finish();
  send({
    phase: stopped ? "paused" : "complete",
    done: 1,
    total: 1,
    elapsed: Date.now() - started,
  });
} catch (error) {
  timing.finish();
  send({ phase: "error", error: error.message });
} finally {
  release?.();
  db.close();
  parentPort.close();
}
