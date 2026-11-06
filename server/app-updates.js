import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40,64}$/;
const KEY = "appUpdates";
const SIX_HOURS = 6 * 60 * 60 * 1000;

// All network traffic is Git to the configured GitHub origin. Summarization, if
// supplied by the host, must use its local inference service.
export function createAppUpdates(db, options = {}) {
  const {
    cwd = process.cwd(),
    now = Date.now,
    summarize,
    isBusy = () => false,
    intervalMs = SIX_HOURS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options;
  const git =
    options.git ||
    (async (args) => {
      const { stdout } = await exec("git", args, {
        cwd,
        shell: false,
        timeout: 30_000,
        maxBuffer: 256 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
          GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oConnectTimeout=10",
        },
      });
      return stdout;
    });
  const run = async (...args) => String(await git(args)).trim();
  let saved = {};
  try {
    saved = JSON.parse(
      db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY)?.value ||
        "{}",
    );
  } catch {
    /* Invalid older preference: use defaults. */
  }
  let state = {
    enabled: saved.enabled !== false,
    skippedVersion: SHA.test(saved.skippedVersion || "")
      ? saved.skippedVersion
      : null,
    lastChecked: Number.isFinite(saved.lastChecked) ? saved.lastChecked : null,
    currentSha: null,
    targetSha: SHA.test(saved.pendingUpdate?.sha || "")
      ? saved.pendingUpdate.sha
      : null,
    branch: saved.pendingUpdate?.branch || null,
    behind: 0,
    ahead: 0,
    commits: [],
    summary: null,
    summarySource: null,
    available: false,
    checking: false,
    applying: false,
    error: null,
    canUpdate: false,
    dependenciesChanged: false,
    blockedReason: null,
    restartRequired: false,
    updatedVersion: null,
  };
  let operation = null,
    timer = null,
    started = false,
    checkedOrigin = null;
  let pendingUpdate = saved.pendingUpdate || null;
  const summaryCache = new Map();
  let dependencyCache = null;
  async function dependenciesChanged(current, target) {
    const key = `${current}:${target}`;
    if (dependencyCache?.key === key) return dependencyCache.changed;
    const files = (
      await run(
        "diff",
        "--name-only",
        current,
        target,
        "--",
        "package.json",
        "package-lock.json",
        "npm-shrinkwrap.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "bun.lock",
        "bun.lockb",
      )
    )
      .split("\n")
      .filter(Boolean);
    let changed = files.some((file) => file !== "package.json");
    if (!changed && files.includes("package.json")) {
      try {
        const before = JSON.parse(await run("show", `${current}:package.json`));
        const after = JSON.parse(await run("show", `${target}:package.json`));
        changed = [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "peerDependencies",
          "peerDependenciesMeta",
          "bundledDependencies",
          "bundleDependencies",
          "engines",
          "packageManager",
          "overrides",
          "resolutions",
          "workspaces",
        ].some(
          (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
        );
      } catch {
        changed = true;
      }
    }
    dependencyCache = { key, changed };
    return changed;
  }
  function persist() {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(
      KEY,
      JSON.stringify({
        enabled: state.enabled,
        skippedVersion: state.skippedVersion,
        lastChecked: state.lastChecked,
        pendingUpdate,
      }),
    );
  }
  function snapshot() {
    return {
      ...state,
      commits: state.commits.map((commit) => ({ ...commit })),
    };
  }
  async function remote() {
    const origin = await run("remote", "get-url", "origin");
    if (
      !/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)[\w.-]+\/[\w.-]+(?:\.git)?$/.test(
        origin,
      )
    )
      throw new Error("Only a configured GitHub origin can be checked.");
    const refs = await run("ls-remote", "--symref", "origin", "HEAD");
    const branch = refs.match(/^ref: refs\/heads\/([^\s]+)\s+HEAD$/m)?.[1];
    if (!branch)
      throw new Error("The origin default branch could not be determined.");
    await run("check-ref-format", "--branch", branch);
    if (
      branch.startsWith("-") ||
      branch.includes("..") ||
      !/^[\w./-]+$/.test(branch)
    )
      throw new Error("The origin default branch is unsupported.");
    await run(
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "origin",
      `refs/heads/${branch}:refs/remotes/origin/${branch}`,
    );
    const target = await run(
      "rev-parse",
      "--verify",
      `refs/remotes/origin/${branch}^{commit}`,
    );
    if (!SHA.test(target))
      throw new Error("The update commit could not be verified.");
    return { origin, branch, target };
  }
  async function assess() {
    state.canUpdate = false;
    if (!state.targetSha) {
      state.dependenciesChanged = false;
      return;
    }
    state.currentSha = await run("rev-parse", "--verify", "HEAD");
    if (state.currentSha === pendingUpdate?.sha)
      state.updatedVersion = pendingUpdate.sha;
    const branch = await run("branch", "--show-current");
    const counts = (
      await run(
        "rev-list",
        "--left-right",
        "--count",
        `${state.currentSha}...${state.targetSha}`,
      )
    )
      .split(/\s+/)
      .map(Number);
    [state.ahead, state.behind] = counts;
    state.available =
      state.enabled &&
      state.behind > 0 &&
      state.targetSha !== state.skippedVersion;
    state.dependenciesChanged = await dependenciesChanged(
      state.currentSha,
      state.targetSha,
    );
    state.blockedReason = null;
    if (!state.enabled)
      state.blockedReason =
        "Update reminders are disabled. Enable them and check again before updating.";
    else if (state.targetSha === state.skippedVersion)
      state.blockedReason =
        "This update was dismissed. Check and review it again before updating.";
    else if (isBusy())
      state.blockedReason = "Wait for indexing and model work to finish.";
    else if (branch !== state.branch)
      state.blockedReason = `Switch to the default branch (${state.branch}) before updating.`;
    else if (
      await run(
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
      )
    )
      state.blockedReason =
        "Commit or move local changes and untracked files before updating.";
    else if (state.ahead > 0)
      state.blockedReason =
        "Local commits have diverged from the update. Update manually.";
    else if (state.behind === 0) state.blockedReason = "Atlas is up to date.";
    else if (state.dependenciesChanged)
      state.blockedReason =
        "This update changes dependencies or runtime requirements. Update manually, install the required dependencies, and restart Atlas.";
    state.canUpdate =
      state.available &&
      !state.blockedReason &&
      !state.checking &&
      !state.applying;
  }
  async function status() {
    if (!operation) {
      try {
        await assess();
      } catch {
        state.canUpdate = false;
        state.blockedReason = "The local checkout could not be verified.";
      }
    }
    const result = snapshot();
    if (isBusy()) {
      result.canUpdate = false;
      result.blockedReason = "Wait for indexing and model work to finish.";
    }
    return result;
  }
  function exclusive(kind, action) {
    if (operation) return operation.then(() => status());
    state[kind] = true;
    state.canUpdate = false;
    operation = (async () => {
      try {
        state.error = null;
        await action();
      } catch (error) {
        state.error =
          error.safeMessage ||
          (error.message?.startsWith("Only a configured") ||
          error.message?.startsWith("The origin default")
            ? error.message
            : "The update operation failed. Check Git access and try again.");
      } finally {
        state[kind] = false;
        operation = null;
      }
      return status();
    })();
    return operation;
  }
  async function check() {
    if (state.applying)
      return {
        ...(await status()),
        error:
          "An update is being applied. Wait for it to finish before checking again.",
      };
    return exclusive("checking", async () => {
      // Never retain an old actionable target after a failed refresh.
      state.targetSha = null;
      state.available = false;
      state.commits = [];
      state.summary = null;
      state.summarySource = null;
      state.lastChecked = now();
      persist();
      const result = await remote();
      checkedOrigin = result.origin;
      state.branch = result.branch;
      state.targetSha = result.target;
      await assess();
      if (state.behind > 0) {
        const log = await run(
          "log",
          "--format=%H%x09%s",
          "-20",
          `${state.currentSha}..${state.targetSha}`,
          "--",
        );
        state.commits = log
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const split = line.indexOf("\t");
            return {
              sha: line.slice(0, split),
              subject: line.slice(split + 1, split + 241),
            };
          });
        state.summary = state.commits
          .slice(0, 5)
          .map((c) => c.subject)
          .join("\n");
        state.summarySource = "commits";
        const summaryKey = `${state.currentSha}:${state.targetSha}`;
        if (summaryCache.has(summaryKey)) {
          state.summary = summaryCache.get(summaryKey);
          state.summarySource = "local";
        } else if (
          summarize &&
          state.enabled &&
          state.targetSha !== state.skippedVersion &&
          !isBusy()
        ) {
          try {
            let timeout;
            let summary;
            try {
              summary = await Promise.race([
                Promise.resolve(
                  summarize(state.commits.map((c) => ({ ...c }))),
                ),
                new Promise((_, reject) => {
                  timeout = setTimeout(
                    () => reject(new Error("timeout")),
                    15_000,
                  );
                  timeout.unref?.();
                }),
              ]);
            } finally {
              clearTimeout(timeout);
            }
            if (typeof summary === "string" && summary.trim()) {
              state.summary = summary.trim().slice(0, 1600);
              state.summarySource = "local";
              summaryCache.set(summaryKey, state.summary);
              if (summaryCache.size > 8)
                summaryCache.delete(summaryCache.keys().next().value);
            }
          } catch {
            /* Commit subjects are the bounded, inspectable fallback. */
          }
        }
      }
    });
  }
  async function preferences(body = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      return {
        ...(await status()),
        error: "Update preferences must be an object.",
      };
    if (Object.hasOwn(body, "enabled")) {
      if (typeof body.enabled !== "boolean")
        return { ...(await status()), error: "enabled must be a boolean." };
    }
    if (Object.hasOwn(body, "skipVersion")) {
      if (
        body.skipVersion !== null &&
        (!SHA.test(body.skipVersion) || body.skipVersion !== state.targetSha)
      )
        return {
          ...(await status()),
          error: "Dismiss only the currently checked update.",
        };
    }
    if (Object.hasOwn(body, "enabled")) state.enabled = body.enabled;
    if (Object.hasOwn(body, "skipVersion"))
      state.skippedVersion = body.skipVersion;
    persist();
    state.error = null;
    schedule();
    return status();
  }
  function reject(message) {
    const error = new Error(message);
    error.safeMessage = message;
    throw error;
  }
  async function apply(body = {}) {
    if (operation)
      return {
        ...(await status()),
        error: "An update operation is already running.",
      };
    if (!body || typeof body !== "object" || Array.isArray(body))
      return {
        ...(await status()),
        error: "The update request must be an object.",
      };
    const expected = body.expectedSha;
    if (
      !SHA.test(expected || "") ||
      expected !== state.targetSha ||
      !checkedOrigin
    )
      return {
        ...(await status()),
        error: "Check for updates again before applying this version.",
      };
    return exclusive("applying", async () => {
      await assess();
      if (state.blockedReason || !state.available)
        reject(
          state.blockedReason ||
            "This update is no longer available. Check again before updating.",
        );
      const originalHead = state.currentSha;
      const result = await remote();
      if (
        result.target !== expected ||
        result.branch !== state.branch ||
        result.origin !== checkedOrigin
      )
        reject("The available update changed. Check for updates again.");
      await assess();
      if (
        state.blockedReason ||
        !state.available ||
        state.currentSha !== originalHead
      )
        reject(
          state.blockedReason ||
            "The local checkout changed. Check for updates again.",
        );
      // Keep application data private even if a future remote tree adds .atlas.
      if (await run("ls-tree", "--name-only", expected, "--", ".atlas"))
        reject("The update includes local data paths. Update manually.");
      await run("merge-base", "--is-ancestor", originalHead, expected);
      if (isBusy()) reject("Wait for indexing and model work to finish.");
      if (!state.enabled || state.skippedVersion === expected)
        reject(
          "This update is no longer enabled. Check and review it again before updating.",
        );
      // No hooks, autostash, force, reset, cleanup, or ignored-file overwrite.
      pendingUpdate = { sha: expected, branch: state.branch };
      persist();
      await run(
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "merge.autoStash=false",
        "merge",
        "--ff-only",
        "--no-overwrite-ignore",
        expected,
      );
      state.restartRequired = true;
      state.currentSha = await run("rev-parse", "HEAD");
    });
  }
  function schedule(forceStartupCheck = false) {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (!started || !state.enabled) return;
    const delay =
      forceStartupCheck || state.lastChecked === null
        ? 1000
        : Math.max(1000, intervalMs - (now() - state.lastChecked));
    timer = setTimer(async () => {
      timer = null;
      if (state.enabled) await check();
      schedule();
    }, delay);
    timer?.unref?.();
  }
  return {
    status,
    check,
    preferences,
    apply,
    start() {
      started = true;
      schedule(true);
    },
    stop() {
      started = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
