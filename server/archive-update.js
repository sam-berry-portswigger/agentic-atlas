import { Worker } from "node:worker_threads";
import { getConfig } from "./db.js";
import { archiveFreshness } from "./freshness.js";
export async function updateArchive(
  db,
  send = () => {},
  isStopped = () => false,
) {
  const fresh = await archiveFreshness(db, { force: true });
  const config = getConfig(db);
  const pending = db
    .prepare(
      "SELECT 1 FROM chunks WHERE vector IS NULL OR model IS NOT ? LIMIT 1",
    )
    .get(config.embeddingModel);
  if (!fresh.pending && !pending) return;
  send({ phase: "syncing", done: 0, total: 0 });
  await new Promise((resolve, reject) => {
    let failure = null;
    const indexer = new Worker(new URL("./worker.js", import.meta.url), {
      workerData: { config, skipProjection: true },
    });
    const cancel = setInterval(() => {
      if (isStopped()) indexer.postMessage("stop");
    }, 250);
    indexer.on("message", (message) => {
      if (message.phase === "error") failure = new Error(message.error);
      else
        send({
          phase: "syncing",
          done: message.done,
          total: message.total,
          detail: message.phase,
        });
    });
    indexer.on("error", (error) => (failure = error));
    indexer.on("exit", (code) => {
      clearInterval(cancel);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(new Error("Could not update the session index."));
      else resolve();
    });
  });
}
