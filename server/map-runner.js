import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const projectionPython = () =>
  process.env.ATLAS_PROJECTION_PYTHON ||
  fileURLToPath(
    new URL("../.atlas/projection-venv/bin/python", import.meta.url),
  );

const cancelled = () =>
  Object.assign(new Error("Projection cancelled."), { name: "AbortError" });

// No shell, archive text, temporary vector files, network or persistent service.
export function runMap(
  vectors,
  {
    send = () => {},
    signal,
    isStopped = () => false,
    python = projectionPython(),
    script = fileURLToPath(new URL("./projection-umap.py", import.meta.url)),
    timeoutMs = 120000,
  } = {},
) {
  signal?.throwIfAborted();
  if (isStopped()) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENBLAS_NUM_THREADS: "2",
        OMP_NUM_THREADS: "2",
        MKL_NUM_THREADS: "2",
        NUMBA_NUM_THREADS: "2",
        PYTHONUNBUFFERED: "1",
      },
    });
    let pending = "",
      stderr = "",
      result,
      failure,
      finished = false,
      killTimer;
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearInterval(poll);
      signal?.removeEventListener("abort", abort);
    };
    const stop = (error) => {
      if (finished || failure) return;
      failure = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const abort = () => stop(cancelled());
    const timeout = setTimeout(
      () =>
        stop(
          new Error(
            "Map projection timed out. The saved map is unchanged; retry Refresh map.",
          ),
        ),
      timeoutMs,
    );
    const poll = setInterval(() => {
      if (isStopped()) abort();
    }, 50);
    signal?.addEventListener("abort", abort, { once: true });
    const consume = (line) => {
      if (!line.trim()) return;
      const value = JSON.parse(line);
      if (value.type === "progress") {
        if (
          !Number.isFinite(value.done) ||
          value.done < 0 ||
          value.done > 1000 ||
          value.total !== 1000
        )
          throw new Error("Invalid map projection progress.");
        send(
          "projecting",
          value.done,
          1000,
          "Preserving conversation neighbourhoods",
        );
      } else if (value.type === "result") {
        if (
          result ||
          !Array.isArray(value.points) ||
          value.points.length !== vectors.length ||
          !value.points.every(
            (p) =>
              Array.isArray(p) && p.length === 2 && p.every(Number.isFinite),
          )
        )
          throw new Error("Invalid projected coordinates.");
        if (
          value.labels !== undefined &&
          (!Array.isArray(value.labels) ||
            value.labels.length !== vectors.length ||
            value.labels.some(
              (n) => !Number.isInteger(n) || n < -1 || n >= vectors.length,
            ))
        )
          throw new Error("Invalid density cluster assignments.");
        result = value;
      } else throw new Error("Invalid map projection response.");
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      if (failure) return;
      pending += text;
      if (pending.length > 512000)
        return stop(new Error("Map projection response exceeded its limit."));
      try {
        let end;
        while ((end = pending.indexOf("\n")) >= 0) {
          consume(pending.slice(0, end));
          pending = pending.slice(end + 1);
        }
      } catch (error) {
        stop(error);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
      stderr = (stderr + text).slice(-8192);
    });
    child.stdin.on("error", () => {}); // Exit/error handler reports a broken worker.
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(
        new Error(
          `Local map runtime could not start (${error.code || "worker error"}). Run npm run setup:projection, then retry Refresh map.`,
        ),
      );
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (!failure && pending.trim()) {
        try {
          consume(pending);
        } catch (error) {
          failure = error;
        }
      }
      if (failure) return reject(failure);
      if (code !== 0 || !result)
        return reject(
          new Error(
            /ModuleNotFoundError|No module named/.test(stderr)
              ? "Local map dependencies are missing. Run npm run setup:projection, then retry Refresh map."
              : "Local map projection failed. The saved map is unchanged; retry Refresh map.",
          ),
        );
      resolve(result);
    });
    child.stdin.end(JSON.stringify({ vectors }));
    if (signal?.aborted || isStopped()) abort();
  });
}
