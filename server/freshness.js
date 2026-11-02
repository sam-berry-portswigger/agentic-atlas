import { stat } from "node:fs/promises";
import { archiveFiles } from "./parser.js";
import { getConfig } from "./db.js";
let cached = null,
  checkedAt = 0,
  cacheKey = "",
  checking = null;
export async function archiveFreshness(db, { force = false } = {}) {
  const config = getConfig(db);
  const key = JSON.stringify([config.source, config.codexSource]);
  if (!force && cacheKey === key && Date.now() - checkedAt < 10000)
    return cached;
  if (checking) return checking;
  checking = (async () => {
    const known = new Map(
      db
        .prepare("SELECT * FROM files")
        .all()
        .map((row) => [row.path, row]),
    );
    const files = await archiveFiles(config);
    let added = 0,
      changed = 0;
    for (let i = 0; i < files.length; i += 32)
      await Promise.all(
        files.slice(i, i + 32).map(async (file) => {
          const old = known.get(file);
          known.delete(file);
          if (!old) {
            added++;
            return;
          }
          const info = await stat(file);
          if (
            info.size !== old.size ||
            Math.abs(info.mtimeMs - old.mtime) > 0.01
          )
            changed++;
        }),
      );
    cached = {
      source: config.source,
      codexSource: config.codexSource,
      added,
      changed,
      removed: known.size,
      pending: added + changed + known.size > 0,
    };
    cacheKey = key;
    checkedAt = Date.now();
    return cached;
  })();
  try {
    return await checking;
  } finally {
    checking = null;
  }
}
export function invalidateFreshness() {
  checkedAt = 0;
}
