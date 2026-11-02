import test from "node:test";
import assert from "node:assert/strict";
import { createSyncCoordinator } from "../server/sync-coordinator.js";

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
function fixture(options = {}) {
  let time = 0,
    id = 0;
  const timers = new Map();
  const coordinator = createSyncCoordinator({
    check: async () => false,
    run: async () => {},
    now: () => time,
    intervalMs: 100,
    demandMs: 500,
    debounceMs: 10,
    busyRetryMs: 5,
    maxBackoffMs: 800,
    setTimer(fn, delay) {
      timers.set(++id, { fn, at: time + delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    ...options,
  });
  return {
    coordinator,
    timers,
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        time = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      time = end;
      await flush();
    },
  };
}
test("foreground requests from multiple tabs coalesce and unchanged ticks never run sync", async () => {
  let checks = 0,
    runs = 0;
  const f = fixture({
    check: async () => {
      checks++;
      return false;
    },
    run: async () => {
      runs++;
    },
  });
  for (let i = 0; i < 20; i++) f.coordinator.foreground();
  await f.advance(10);
  assert.equal(checks, 1);
  assert.equal(runs, 0);
  assert.equal(f.timers.size, 1);
  for (let i = 0; i < 20; i++) f.coordinator.foreground();
  await f.advance(99);
  assert.equal(checks, 1);
  await f.advance(1);
  assert.equal(checks, 2);
  assert.equal(runs, 0);
});
test("a manual request during sync queues only one bounded follow-up for arriving changes", async () => {
  let finish,
    checks = 0,
    runs = 0;
  const f = fixture({
    check: async () => {
      checks++;
      return true;
    },
    run: async () => {
      runs++;
      if (runs === 1)
        await new Promise((resolve) => {
          finish = resolve;
        });
    },
  });
  const first = f.coordinator.request();
  await flush();
  for (let i = 0; i < 10; i++) void f.coordinator.request();
  assert.equal(runs, 1);
  assert.equal(f.coordinator.snapshot().queued, true);
  finish();
  await first;
  await f.advance(10);
  assert.equal(checks, 2);
  assert.equal(runs, 2);
  assert.equal(f.coordinator.snapshot().queued, false);
  assert.equal(f.timers.size, 1);
});
test("pause prevents foreground polling from restarting a job; manual sync resumes it", async () => {
  let finish,
    runs = 0;
  const f = fixture({
    check: async () => true,
    run: async () => {
      runs++;
      if (runs === 1)
        await new Promise((resolve) => {
          finish = resolve;
        });
    },
  });
  const first = f.coordinator.request();
  await flush();
  f.coordinator.pause();
  f.coordinator.foreground();
  finish();
  await first;
  await f.advance(1000);
  assert.equal(runs, 1);
  assert.equal(f.coordinator.snapshot().paused, true);
  assert.equal(f.timers.size, 0);
  await f.coordinator.request();
  assert.equal(runs, 2);
  assert.equal(f.coordinator.snapshot().paused, false);
});
test("background failures back off instead of launching on every UI heartbeat", async () => {
  let checks = 0,
    errors = 0;
  const f = fixture({
    demandMs: 5000,
    check: () => {
      checks++;
      throw new Error("Local model unavailable");
    },
    onError: () => {
      errors++;
    },
  });
  f.coordinator.foreground();
  await f.advance(10);
  assert.equal(checks, 1);
  assert.equal(errors, 1);
  for (let i = 0; i < 30; i++) f.coordinator.foreground();
  await f.advance(199);
  assert.equal(checks, 1);
  await f.advance(1);
  assert.equal(checks, 2);
  await f.advance(399);
  assert.equal(checks, 2);
  await f.advance(1);
  assert.equal(checks, 3);
  assert.match(f.coordinator.snapshot().lastError, /model unavailable/);
});
test("other work defers inventory checks and external writer-lock contention retries quicsvy", async () => {
  let busy = true,
    checks = 0,
    runs = 0,
    errors = 0;
  const f = fixture({
    isBusy: () => busy,
    check: async () => {
      checks++;
      return true;
    },
    run: async () => {
      runs++;
      if (runs === 1)
        throw new Error(
          "Another Atlas index update is running. Try again shortly.",
        );
    },
    onError: () => {
      errors++;
    },
  });
  f.coordinator.foreground();
  await f.advance(10);
  assert.equal(checks, 0);
  busy = false;
  await f.advance(5);
  assert.equal(checks, 1);
  assert.equal(runs, 1);
  assert.equal(errors, 0);
  await f.advance(5);
  assert.equal(runs, 2);
  assert.equal(f.coordinator.snapshot().lastError, null);
});
test("hidden pages stop periodic checks after the lease, and returning catches up", async () => {
  let checks = 0;
  const f = fixture({
    check: async () => {
      checks++;
      return false;
    },
  });
  f.coordinator.foreground();
  await f.advance(1000);
  assert.equal(checks, 5);
  assert.equal(f.timers.size, 0);
  f.coordinator.foreground();
  await f.advance(10);
  assert.equal(checks, 6);
});
test("pause during discovery prevents starting a worker after the inventory resolves", async () => {
  let finish,
    runs = 0;
  const f = fixture({
    check: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    run: async () => {
      runs++;
    },
  });
  const pending = f.coordinator.request();
  await flush();
  f.coordinator.pause();
  finish(true);
  await pending;
  assert.equal(runs, 0);
  assert.equal(f.timers.size, 0);
});
test("closing coordinator cancels timers and ignores later demand", async () => {
  let checks = 0;
  const f = fixture({
    check: async () => {
      checks++;
      return true;
    },
  });
  f.coordinator.foreground();
  f.coordinator.close();
  f.coordinator.foreground();
  await f.advance(1000);
  assert.equal(checks, 0);
  assert.equal(f.timers.size, 0);
});
test("a persisted pause survives a new coordinator until explicit manual resume", async () => {
  let checks = 0;
  const f = fixture({
    initialPaused: true,
    check: async () => {
      checks++;
      return false;
    },
  });
  f.coordinator.foreground();
  await f.advance(1000);
  assert.equal(checks, 0);
  await f.coordinator.request();
  assert.equal(checks, 1);
  assert.equal(f.coordinator.snapshot().paused, false);
});
