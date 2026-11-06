// One bounded sync queue per API process. Independent MCP/search writers still
// arbitrate through the existing index lock inside the worker.
export function createSyncCoordinator({
  check,
  run,
  isBusy = () => false,
  onIdle = () => {},
  onError = () => {},
  initialSuccessfulAt = null,
  initialPaused = false,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  intervalMs = 30000,
  demandMs = 45000,
  debounceMs = 500,
  busyRetryMs = 5000,
  maxBackoffMs = 300000,
} = {}) {
  let timer = null,
    timerAt = null,
    activeUntil = 0,
    paused = initialPaused,
    stopped = false,
    inflight = null,
    queued = false,
    nextCheckAt = 0,
    lastCheckedAt = null,
    lastSuccessfulAt = initialSuccessfulAt,
    lastError = null,
    failures = 0;
  const busyError = (error) =>
    /another Atlas index update|already running|index.*busy/i.test(
      error?.message || "",
    );
  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = timerAt = null;
  }
  function schedule(at) {
    if (stopped || paused || inflight || activeUntil <= now()) return;
    if (timer !== null && timerAt <= at) return;
    cancelTimer();
    timerAt = at;
    timer = setTimer(
      () => {
        timer = timerAt = null;
        void tick();
      },
      Math.max(0, at - now()),
    );
    timer?.unref?.();
  }
  function tick({ manual = false } = {}) {
    if (stopped || paused || (!manual && activeUntil <= now()))
      return Promise.resolve(false);
    if (inflight) {
      if (manual) queued = true;
      return inflight;
    }
    cancelTimer();
    if (!manual && now() < nextCheckAt) {
      schedule(nextCheckAt);
      return Promise.resolve(false);
    }
    if (isBusy()) {
      nextCheckAt = now() + busyRetryMs;
      schedule(nextCheckAt);
      return Promise.resolve(false);
    }
    inflight = (async () => {
      // Always assign inflight before a synchronous check/error can settle it.
      await Promise.resolve();
      let retryDelay = null;
      try {
        lastCheckedAt = new Date(now()).toISOString();
        const pending = await check({ manual });
        if (paused || stopped) return false;
        if (!pending) {
          failures = 0;
          lastError = null;
          if (manual) onIdle();
          return false;
        }
        // Another local operation may have started while inventory was read.
        if (isBusy()) {
          retryDelay = busyRetryMs;
          return false;
        }
        await run({ automatic: !manual });
        if (!paused && !stopped) {
          lastSuccessfulAt = new Date(now()).toISOString();
          lastError = null;
          failures = 0;
        }
        return true;
      } catch (error) {
        if (!paused && !stopped) {
          if (busyError(error)) retryDelay = busyRetryMs;
          else {
            failures++;
            lastError = error.message;
            retryDelay = Math.min(maxBackoffMs, intervalMs * 2 ** failures);
            onError(error, { automatic: !manual });
          }
        }
        return false;
      } finally {
        inflight = null;
        if (!stopped && !paused) {
          const immediate = queued;
          queued = false;
          nextCheckAt =
            now() + (retryDelay ?? (immediate ? debounceMs : intervalMs));
          schedule(nextCheckAt);
        }
      }
    })();
    return inflight;
  }
  return {
    foreground() {
      const resumed = activeUntil <= now();
      activeUntil = now() + demandMs;
      if (resumed) schedule(Math.max(nextCheckAt, now() + debounceMs));
      else if (timer === null) schedule(Math.max(nextCheckAt, now()));
    },
    request() {
      paused = false;
      activeUntil = now() + demandMs;
      nextCheckAt = 0;
      return tick({ manual: true });
    },
    pause() {
      paused = true;
      queued = false;
      cancelTimer();
    },
    close() {
      stopped = true;
      queued = false;
      cancelTimer();
    },
    snapshot() {
      return {
        paused,
        running: inflight !== null,
        active: activeUntil > now(),
        queued,
        lastCheckedAt,
        lastSuccessfulAt,
        nextCheckAt: timerAt === null ? null : new Date(timerAt).toISOString(),
        lastError,
      };
    },
  };
}
