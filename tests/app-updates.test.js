import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { createAppUpdates } from "../server/app-updates.js";
const exec = promisify(execFile);
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "atlas-updates-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source"),
    cwd = path.join(dir, "app");
  await mkdir(source);
  const git = async (at, args) =>
    (
      await exec(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "-c",
          "commit.gpgSign=false",
          ...args,
        ],
        { cwd: at, timeout: 10000 },
      )
    ).stdout;
  await git(source, ["init", "-b", "main"]);
  await writeFile(path.join(source, ".gitignore"), ".atlas/\n");
  await writeFile(
    path.join(source, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      dependencies: {},
      engines: { node: ">=22" },
    }),
  );
  await writeFile(path.join(source, "app.txt"), "original\n");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "Initial"]);
  await git(dir, ["clone", source, cwd]);
  await writeFile(path.join(source, "app.txt"), "updated\n");
  await git(source, ["commit", "-am", "Improve update visibility"]);
  const target = (await git(source, ["rev-parse", "HEAD"])).trim();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  t.after(() => db.close());
  const calls = [];
  const dependencies = {
    cwd,
    git: async (args) => {
      calls.push(args);
      if (args.join(" ") === "remote get-url origin")
        return "git@github.com:test/atlas.git";
      return git(cwd, args);
    },
    ...options,
  };
  const service = createAppUpdates(db, dependencies);
  t.after(() => service.stop());
  return { service, db, dependencies, calls, cwd, source, target, git };
}
test("checks are read-only and an explicit fast-forward preserves ignored local data", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.cwd, ".atlas"));
  await writeFile(path.join(f.cwd, ".atlas", "private.txt"), "private");
  const before = (await f.git(f.cwd, ["rev-parse", "HEAD"])).trim();
  const checked = await f.service.check();
  assert.equal(checked.error, null);
  assert.equal(checked.behind, 1);
  assert.equal(checked.ahead, 0);
  assert.equal(checked.canUpdate, true);
  assert.equal(checked.targetSha, f.target);
  assert.equal(checked.summary, "Improve update visibility");
  assert.equal((await f.git(f.cwd, ["rev-parse", "HEAD"])).trim(), before);
  const applied = await f.service.apply({ expectedSha: f.target });
  assert.equal(applied.error, null);
  assert.equal(applied.restartRequired, true);
  assert.equal(applied.behind, 0);
  assert.equal(
    await readFile(path.join(f.cwd, "app.txt"), "utf8"),
    "updated\n",
  );
  assert.equal(
    await readFile(path.join(f.cwd, ".atlas", "private.txt"), "utf8"),
    "private",
  );
  const merge = f.calls.find((args) => args.includes("merge"));
  assert.ok(merge.includes("--ff-only"));
  assert.ok(merge.includes("core.hooksPath=/dev/null"));
});
for (const kind of ["tracked", "untracked", "diverged", "branch"]) {
  test(`update refuses ${kind} checkout without overwriting local work`, async (t) => {
    const f = await fixture(t);
    await f.service.check();
    if (kind === "tracked")
      await writeFile(path.join(f.cwd, "app.txt"), "my work\n");
    if (kind === "untracked")
      await writeFile(path.join(f.cwd, "personal.txt"), "my work\n");
    if (kind === "diverged") {
      await writeFile(path.join(f.cwd, "personal.txt"), "my work\n");
      await f.git(f.cwd, ["add", "."]);
      await f.git(f.cwd, ["commit", "-m", "Local work"]);
    }
    if (kind === "branch") await f.git(f.cwd, ["switch", "-c", "work"]);
    const before = await f.git(f.cwd, ["rev-parse", "HEAD"]);
    const result = await f.service.apply({ expectedSha: f.target });
    assert.ok(result.error);
    assert.equal(result.canUpdate, false);
    assert.equal(await f.git(f.cwd, ["rev-parse", "HEAD"]), before);
    assert.ok(!f.calls.some((args) => args.includes("merge")));
    if (kind === "tracked")
      assert.equal(
        await readFile(path.join(f.cwd, "app.txt"), "utf8"),
        "my work\n",
      );
  });
}
test("requires checked SHA and refuses a remote that advances after review", async (t) => {
  const f = await fixture(t);
  assert.ok((await f.service.apply({ expectedSha: f.target })).error);
  await f.service.check();
  assert.ok((await f.service.apply({ expectedSha: "a".repeat(40) })).error);
  await writeFile(path.join(f.source, "next.txt"), "next");
  await f.git(f.source, ["add", "."]);
  await f.git(f.source, ["commit", "-m", "Next update"]);
  const result = await f.service.apply({ expectedSha: f.target });
  assert.match(result.error, /changed/);
  assert.ok(!f.calls.some((args) => args.includes("merge")));
});
test("disabled checks and dismissed versions persist across service recreation", async (t) => {
  const f = await fixture(t);
  await f.service.check();
  await f.service.preferences({ enabled: false, skipVersion: f.target });
  const timers = [];
  const restored = createAppUpdates(f.db, {
    ...f.dependencies,
    setTimer: (...args) => timers.push(args),
  });
  restored.start();
  const result = await restored.status();
  assert.equal(result.enabled, false);
  assert.equal(result.skippedVersion, f.target);
  assert.ok(result.lastChecked);
  assert.equal(timers.length, 0);
  assert.equal((await f.service.status()).available, false);
  restored.stop();
});
test("local summary fallback and busy work block application", async (t) => {
  let busy = false;
  const f = await fixture(t, {
    isBusy: () => busy,
    summarize: async () => {
      throw new Error("local model unavailable");
    },
  });
  assert.equal((await f.service.check()).summarySource, "commits");
  busy = true;
  const result = await f.service.apply({ expectedSha: f.target });
  assert.match(result.error, /indexing/);
  assert.ok(!f.calls.some((args) => args.includes("merge")));
});
test("rejects incoming application data paths", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.source, ".atlas"));
  await writeFile(path.join(f.source, ".atlas", "data.txt"), "remote");
  await f.git(f.source, ["add", "-f", ".atlas/data.txt"]);
  await f.git(f.source, ["commit", "-m", "Data path"]);
  const checked = await f.service.check();
  assert.match(
    (await f.service.apply({ expectedSha: checked.targetSha })).error,
    /local data/,
  );
});

test("successful update is reconciled after a watch-mode restart", async (t) => {
  const f = await fixture(t);
  await f.service.check();
  await f.service.apply({ expectedSha: f.target });
  const restored = createAppUpdates(f.db, f.dependencies);
  const result = await restored.status();
  assert.equal(result.updatedVersion, f.target);
  assert.equal(result.currentSha, f.target);
  assert.equal(result.behind, 0);
  assert.equal(result.restartRequired, false);
});

test("fast-forward never overwrites an ignored local file", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.cwd, ".git", "info", "exclude"), "secret.txt\n");
  await writeFile(path.join(f.cwd, "secret.txt"), "local private data\n");
  await writeFile(path.join(f.source, "secret.txt"), "incoming\n");
  await f.git(f.source, ["add", "secret.txt"]);
  await f.git(f.source, ["commit", "-m", "Add file"]);
  const before = await f.git(f.cwd, ["rev-parse", "HEAD"]);
  const checked = await f.service.check();
  assert.equal(checked.canUpdate, true);
  assert.ok((await f.service.apply({ expectedSha: checked.targetSha })).error);
  assert.equal(
    await readFile(path.join(f.cwd, "secret.txt"), "utf8"),
    "local private data\n",
  );
  assert.equal(await f.git(f.cwd, ["rev-parse", "HEAD"]), before);
});

test("startup promptly restores update knowledge despite a recent persisted check", async (t) => {
  const f = await fixture(t);
  await f.service.check();
  const timers = [];
  const restored = createAppUpdates(f.db, {
    ...f.dependencies,
    setTimer(fn, delay) {
      timers.push({ fn, delay });
      return timers.length;
    },
    clearTimer() {},
  });
  restored.start();
  assert.equal(timers[0].delay, 1000);
  await timers[0].fn();
  assert.equal((await restored.status()).available, true);
  assert.ok(timers[1].delay > 1000);
  restored.stop();
});

test("dismissed and disabled reminders skip local overview generation", async (t) => {
  let summaries = 0;
  const f = await fixture(t, {
    summarize: async () => {
      summaries++;
      return "Local overview";
    },
  });
  assert.equal((await f.service.check()).summarySource, "local");
  await f.service.preferences({ skipVersion: f.target });
  assert.equal((await f.service.check()).available, false);
  assert.equal(summaries, 1);
  await f.service.preferences({ enabled: false, skipVersion: null });
  assert.equal((await f.service.check()).available, false);
  assert.equal(summaries, 1);
});

for (const change of [
  "lockfile",
  "dependencies",
  "engines",
  "packageManager",
]) {
  test(`dependency safety blocks ${change} changes without merging`, async (t) => {
    const f = await fixture(t);
    if (change === "lockfile")
      await writeFile(path.join(f.source, "package-lock.json"), "{}\n");
    else {
      const file = path.join(f.source, "package.json");
      const manifest = JSON.parse(await readFile(file, "utf8"));
      manifest[change] =
        change === "dependencies"
          ? { added: "^1.0.0" }
          : change === "engines"
            ? { node: ">=30" }
            : "npm@12.0.0";
      await writeFile(file, JSON.stringify(manifest));
    }
    await f.git(f.source, ["add", "."]);
    await f.git(f.source, ["commit", "-m", "Change runtime requirements"]);
    const before = await f.git(f.cwd, ["rev-parse", "HEAD"]);
    const checked = await f.service.check();
    assert.equal(checked.dependenciesChanged, true);
    assert.equal(checked.canUpdate, false);
    assert.match(checked.blockedReason, /manually.*install.*restart/);
    assert.ok(
      (await f.service.apply({ expectedSha: checked.targetSha })).error,
    );
    assert.equal(await f.git(f.cwd, ["rev-parse", "HEAD"]), before);
    assert.ok(!f.calls.some((args) => args.includes("merge")));
  });
}

test("package version and description changes permit a code-only update", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.source, "package.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  await writeFile(
    file,
    JSON.stringify({
      ...manifest,
      version: "1.0.1",
      description: "Updated description",
    }),
  );
  await f.git(f.source, ["commit", "-am", "Update metadata"]);
  const checked = await f.service.check();
  assert.equal(checked.dependenciesChanged, false);
  assert.equal(checked.canUpdate, true);
  assert.equal(
    (await f.service.apply({ expectedSha: checked.targetSha })).error,
    null,
  );
});

for (const preference of [{ enabled: false }, { skipVersion: "target" }]) {
  test(`cached apply cannot bypass ${Object.keys(preference)[0]} preference`, async (t) => {
    const f = await fixture(t);
    await f.service.check();
    await f.service.preferences(
      preference.skipVersion ? { skipVersion: f.target } : preference,
    );
    const result = await f.service.apply({ expectedSha: f.target });
    assert.ok(result.error);
    assert.equal(result.available, false);
    assert.equal(result.canUpdate, false);
    assert.ok(!f.calls.some((args) => args.includes("merge")));
  });
}

test("preferences reject malformed bodies atomically and successful changes clear background errors", async (t) => {
  const f = await fixture(t);
  await f.service.check();
  for (const body of [
    null,
    [],
    false,
    "disabled",
    { enabled: false, skipVersion: "invalid" },
  ]) {
    const result = await f.service.preferences(body);
    assert.ok(result.error);
    assert.equal(result.enabled, true);
    assert.equal(result.skippedVersion, null);
  }
  const failed = createAppUpdates(f.db, {
    ...f.dependencies,
    git: async () => {
      throw new Error("private Git failure");
    },
  });
  assert.ok((await failed.check()).error);
  const disabled = await failed.preferences({ enabled: false });
  assert.equal(disabled.error, null);
  assert.equal(disabled.enabled, false);
});

test("successful local summaries are reused and failed inference can retry", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    summarize: async () => {
      if (++calls === 1) throw new Error("offline");
      return "Cached local overview";
    },
  });
  assert.equal((await f.service.check()).summarySource, "commits");
  assert.equal((await f.service.check()).summarySource, "local");
  const cached = await f.service.check();
  assert.equal(cached.summary, "Cached local overview");
  assert.equal(cached.summarySource, "local");
  assert.equal(calls, 2);
});

test("checks and repeated applies never queue a second merge during application", async (t) => {
  const f = await fixture(t);
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const merging = new Promise((resolve) => {
    entered = resolve;
  });
  let merges = 0;
  const service = createAppUpdates(f.db, {
    ...f.dependencies,
    git: async (args) => {
      if (args.includes("merge")) {
        merges++;
        entered();
        await gate;
      }
      return f.dependencies.git(args);
    },
  });
  await service.check();
  const applying = service.apply({ expectedSha: f.target });
  await merging;
  try {
    assert.match((await service.check()).error, /being applied/);
    assert.match(
      (await service.apply({ expectedSha: f.target })).error,
      /already running/,
    );
  } finally {
    release();
  }
  assert.equal((await applying).error, null);
  assert.equal(merges, 1);
});
