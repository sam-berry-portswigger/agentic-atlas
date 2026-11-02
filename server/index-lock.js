import {
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  statSync,
  utimesSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { dataDir } from "./db.js";

// Coordinate index writers across the UI and independent MCP processes. A
// heartbeat also recovers locks left by a forcibly terminated worker thread.
export function acquireIndexLock() {
  const file = path.join(dataDir, "index.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      } finally {
        closeSync(fd);
      }
      const heartbeat = setInterval(() => {
        try {
          if (JSON.parse(readFileSync(file, "utf8")).token === token) {
            const now = new Date();
            utimesSync(file, now, now);
          }
        } catch {}
      }, 5000);
      heartbeat.unref();
      return () => {
        clearInterval(heartbeat);
        try {
          if (JSON.parse(readFileSync(file, "utf8")).token === token)
            unlinkSync(file);
        } catch {}
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let stale = false;
      try {
        stale = Date.now() - statSync(file).mtimeMs > 30000;
        const owner = JSON.parse(readFileSync(file, "utf8"));
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") stale = true;
        }
      } catch {}
      if (!stale)
        throw new Error(
          "Another Atlas index update is running. Try again shortly.",
        );
      try {
        unlinkSync(file);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  throw new Error("Another Atlas index update is running. Try again shortly.");
}
