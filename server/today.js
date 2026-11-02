import { createSessionBrief } from "./session-brief.js";
import { saveSessionTitle, suggestSessionTitle } from "./session-rename.js";
import {
  readSessionTitleEvidence,
  titleEvidenceSampler,
} from "./session-title-evidence.js";
import { startNDJSON } from "./http-stream.js";
import { familyRoots, isFamilyEdge } from "../shared/today-layout.js";
import { attachFamilyPreferences, setFamilyDetached } from "./today-family.js";
import { markSessionRead, attachUnread } from "./session-read.js";
import { claudeDesktopSessions } from "./claude-desktop.js";
import { disambiguateSessionTitles } from "./session-display.js";
import { sessionOptions } from "./session-options.js";
import { logStatus, withLiveStatus } from "./session-status.js";
export { logStatus } from "./session-status.js";
import { streamActivity } from "../shared/today-focus.js";
import { linkSharedHistory, coalesceClaudeRewinds } from "./today-lineage.js";
import { attachTodayStreams } from "./today-streams.js";
import {
  readClaudeLaunches,
  matchClaudeLaunch,
  launchTitle,
} from "./today-origins.js";
import { conversationName } from "./names.js";
import { sessionNameResolver } from "./session-labels.js";
import { open, stat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { getConfig, vectorArray, normalize, cosine } from "./db.js";
import { activeAnalysis } from "./analysis-store.js";
import { sessionFiles, codexSessionFiles, extractText } from "./parser.js";
import {
  createTodayService,
  saveTodayLayout,
  readTodayVisibility,
  setTodayVisibility,
} from "./today-store.js";
const cache = new Map(),
  sessionLogs = new Map();
const ts = (v) =>
  typeof v === "number" ? (v > 1e11 ? v : v * 1000) : Date.parse(v) || 0;
const clean = (s) =>
  String(s || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
function messageTimes(rows) {
  let response = 0,
    request = 0;
  for (const r of rows) {
    const text = extractText({ ...r, isSidechain: false });
    if (
      (text && (r.type === "assistant" || r.payload?.role === "assistant")) ||
      (r.type === "event_msg" &&
        r.payload?.type === "agent_message" &&
        r.payload?.message)
    )
      response = Math.max(response, ts(r.timestamp));
    if (
      (text && (r.type === "user" || r.payload?.role === "user")) ||
      (r.type === "event_msg" && r.payload?.type === "user_message")
    )
      request = Math.max(request, ts(r.timestamp));
  }
  return {
    lastResponseAt: response ? new Date(response).toISOString() : null,
    lastRequestAt: request ? new Date(request).toISOString() : null,
  };
}
function compactRow(r) {
  if (!r || typeof r !== "object") return null;
  const common = {
    uuid: r.uuid || r.payload?.id,
    type: r.type,
    timestamp: r.timestamp,
    cwd: r.cwd,
    sessionId: r.sessionId,
    isMeta: r.isMeta,
    isSidechain: r.isSidechain,
  };
  const content = (items) =>
    typeof items === "string"
      ? items.slice(0, 1200)
      : Array.isArray(items)
        ? items
            .filter((c) =>
              ["text", "input_text", "output_text", "tool_use"].includes(
                c.type,
              ),
            )
            .map((c) => ({
              type: c.type,
              text: c.text?.slice(0, 1200),
              name: c.name,
              id: c.id,
              input:
                c.type === "tool_use"
                  ? {
                      task_id: c.input?.task_id,
                      session_id: c.input?.session_id,
                      cell_id: c.input?.cell_id,
                    }
                  : undefined,
            }))
        : [];
  if (r.type === "session_meta") {
    const p = r.payload || {};
    return {
      ...common,
      payload: {
        id: p.id,
        session_id: p.session_id,
        cwd: p.cwd,
        title: p.title,
        source: p.source,
      },
    };
  }
  if (r.type === "atlas_log_gap") return common;
  if (r.type === "custom-title")
    return { ...common, customTitle: r.customTitle };
  if (r.type === "system") return { ...common, subtype: r.subtype };
  if (["user", "assistant"].includes(r.type))
    return {
      ...common,
      notificationText: (typeof r.message?.content === "string"
        ? r.message.content
        : Array.isArray(r.message?.content)
          ? r.message.content.map((c) => c.text || "").join("\n")
          : ""
      )
        .match(/<task-notification>[\s\S]*?<\/task-notification>/g)
        ?.join("\n"),
      toolResults: Array.isArray(r.message?.content)
        ? r.message.content
            .filter((c) => c.type === "tool_result")
            .map((c) => ({
              tool_use_id: c.tool_use_id,
              content:
                typeof c.content === "string"
                  ? c.content.slice(0, 24000)
                  : content(c.content),
            }))
        : [],
      toolUseResult: r.toolUseResult
        ? {
            backgroundTaskId: r.toolUseResult.backgroundTaskId,
            taskId: r.toolUseResult.taskId,
            status: r.toolUseResult.status,
            task: r.toolUseResult.task
              ? {
                  task_id: r.toolUseResult.task.task_id,
                  id: r.toolUseResult.task.id,
                  status: r.toolUseResult.task.status,
                }
              : undefined,
          }
        : undefined,
      message: {
        content:
          r.type === "user"
            ? extractText({ ...r, isSidechain: false }).slice(0, 1200)
            : content(r.message?.content),
        stop_reason: r.message?.stop_reason,
      },
    };
  if (r.type === "event_msg") {
    const p = r.payload || {};
    return {
      ...common,
      payload: {
        type: p.type,
        message:
          typeof p.message === "string" ? p.message.slice(0, 1200) : undefined,
      },
    };
  }
  if (r.type === "response_item") {
    const p = r.payload || {};
    return {
      ...common,
      payload: {
        type: p.type,
        role: p.role,
        channel: p.channel,
        phase: p.phase,
        name: p.name,
        call_id: p.call_id,
        arguments: p.arguments || p.input,
        output:
          typeof p.output === "string"
            ? p.output.slice(0, 24000)
            : content(p.output),
        content:
          p.role === "user"
            ? [{ type: "input_text", text: extractText(r).slice(0, 1200) }]
            : content(p.content),
      },
    };
  }
  return null;
}
async function entries(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
async function events(file) {
  let f;
  try {
    const s = await stat(file),
      old = cache.get(file);
    if (old?.mtime === s.mtimeMs && old.size === s.size) return old;
    f = await open(file, "r");
    let lines;
    if (s.size > 6000000) {
      const a = Buffer.alloc(600000),
        b = Buffer.alloc(5400000);
      await f.read(a, 0, a.length, 0);
      await f.read(b, 0, b.length, s.size - b.length);
      lines = [
        ...a.toString().split("\n").slice(0, -1),
        JSON.stringify({ type: "atlas_log_gap" }),
        ...b.toString().split("\n").slice(1),
      ];
    } else {
      lines = (await f.readFile("utf8")).split("\n");
    }
    const rows = [];
    for (const l of lines) {
      try {
        const row = compactRow(JSON.parse(l));
        if (row) rows.push(row);
      } catch {}
    }
    const value = {
      mtime: s.mtimeMs,
      size: s.size,
      rows,
      sampled: s.size > 6000000,
    };
    cache.set(file, value);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return value;
  } finally {
    await f?.close();
  }
}
export async function discoverToday(
  config,
  { start, end, now = Date.now(), home = os.homedir() } = {},
) {
  const sessions = new Map(),
    edges = [],
    warnings = [],
    sources = { claude: "Not found", codex: "Not found" };
  function add(s) {
    const old = sessions.get(s.id);
    if (!old || Date.parse(s.updated) > Date.parse(old.updated))
      sessions.set(s.id, s);
  }
  let codexMeta = new Map();
  if (config.codexSource) {
    let c;
    try {
      c = new DatabaseSync(
        path.join(path.dirname(config.codexSource), "state_5.sqlite"),
        { readOnly: true },
      );
      for (const r of c
        .prepare("SELECT * FROM threads WHERE updated_at>=?")
        .all(Math.floor(start / 1000)))
        codexMeta.set(r.id, r);
      for (const e of c.prepare("SELECT * FROM thread_spawn_edges").all())
        edges.push({
          parent: "codex:" + e.parent_thread_id,
          child: "codex:" + e.child_thread_id,
          kind: "spawned",
        });
      sources.codex = "Local index + turn logs";
    } catch {
      sources.codex = "Turn logs only";
    } finally {
      c?.close();
    }
  }
  let claude = [];
  try {
    claude = await sessionFiles(config.source);
    sources.claude = "Local logs";
  } catch {
    warnings.push("Claude source is unavailable.");
  }
  const codex = config.codexSource
    ? await codexSessionFiles(config.codexSource)
    : [];
  if (codex.length && sources.codex === "Not found")
    sources.codex = "Local turn logs";
  const files = [
    ...claude.map((file) => ({ file, provider: "claude" })),
    ...codex.map((file) => ({ file, provider: "codex" })),
  ];
  for (const { file, provider } of files) {
    try {
      const m = await stat(file);
      if (m.mtimeMs < start) continue;
      const data = await events(file),
        rows = data.rows,
        meta = rows.find((r) => r.type === "session_meta")?.payload || {};
      const native =
        provider === "codex"
          ? meta.id || meta.session_id
          : path.basename(file, ".jsonl");
      if (!native) continue;
      const id = provider === "codex" ? "codex:" + native : native,
        info = codexMeta.get(native);
      sessionLogs.set(id, file);
      const source = meta.source || info?.source;
      if (JSON.stringify(source || "").includes("guardian")) continue;
      const sourceObj =
        typeof source === "string"
          ? (() => {
              try {
                return JSON.parse(source);
              } catch {
                return {};
              }
            })()
          : source;
      const spawn = sourceObj?.subagent?.thread_spawn;
      const parent = spawn?.parent_thread_id
        ? "codex:" + spawn.parent_thread_id
        : info?.attached_thread_parent_id
          ? "codex:" + info.attached_thread_parent_id
          : null;
      const user = rows.filter(
        (r) =>
          ts(r.timestamp) >= start &&
          ts(r.timestamp) < end &&
          ((r.type === "user" &&
            !r.isMeta &&
            !r.isSidechain &&
            extractText(r)) ||
            (r.type === "response_item" &&
              r.payload?.role === "user" &&
              extractText(r)) ||
            (r.type === "event_msg" && r.payload?.type === "user_message")),
      );
      const indexedActivity =
        info && info.updated_at * 1000 >= start && !sourceObj?.subagent;
      if (!user.length && !parent && !indexedActivity) continue;
      const title =
        info?.name ||
        info?.title ||
        [...rows].reverse().find((r) => r.type === "custom-title")
          ?.customTitle ||
        extractText(user[0] || {}) ||
        (spawn
          ? "Subagent · " + (spawn.agent_path || native).split("/").pop()
          : "Untitled session");
      const cwd =
        info?.cwd ||
        meta.cwd ||
        [...rows].reverse().find((r) => r.cwd)?.cwd ||
        "";
      const activity = rows.filter((r) =>
        ["user", "assistant", "response_item", "event_msg"].includes(r.type),
      );
      const latest = Math.max(0, ...activity.map((r) => ts(r.timestamp)));
      const requests = rows.filter(
        (r) =>
          r.type === "user" &&
          extractText(r) &&
          !/^\[Request interrupted by user/.test(extractText(r)),
      );
      add({
        id,
        _history:
          provider === "claude"
            ? rows
                .filter((r) => r.uuid && ["user", "assistant"].includes(r.type))
                .map((r) => ({ id: r.uuid }))
            : [],
        _requests: requests
          .map((r) => ({
            id: r.uuid,
            text: extractText(r),
            at: ts(r.timestamp),
          }))
          .filter((r) => r.id),
        _lastRequestAt: Math.max(0, ...requests.map((r) => ts(r.timestamp))),
        ...messageTimes(rows),
        activity:
          provider === "claude"
            ? requests.map((r) => ({
                id: r.uuid || r.timestamp + extractText(r),
                at: r.timestamp,
              }))
            : user
                .filter(
                  (r) => extractText(r) || r.payload?.type === "user_message",
                )
                .map((r) => ({
                  id: r.uuid || r.timestamp + extractText(r),
                  at: r.timestamp,
                })),
        nativeId: native,
        provider,
        title: clean(title),
        project: path.basename(cwd) || "Workspace",
        cwd,
        updated: new Date(latest).toISOString(),
        lastRequest: clean(
          extractText(user.at(-1) || {}) || user.at(-1)?.payload?.message,
        ),
        parent,
        child: !!parent,
        ...logStatus(rows, provider, now),
        inclusion: user.length
          ? "User interaction today"
          : parent
            ? "Child session"
            : "Activity today; user interaction unverified",
        sampled: data.sampled,
        _prompt: extractText(user[0] || {}) || user[0]?.payload?.message || "",
        _created:
          ts(meta.timestamp) ||
          (info?.created_at ? info.created_at * 1000 : ts(rows[0]?.timestamp)),
        userTurns: new Set(
          rows
            .filter(
              (r) =>
                extractText(r) &&
                (r.type === "user" || r.payload?.role === "user"),
            )
            .map((r) => r.uuid || r.timestamp + extractText(r)),
        ).size,
        messageCount: new Set(
          rows
            .filter((r) => extractText(r))
            .map((r) => r.uuid || r.timestamp + extractText(r)),
        ).size,
      });
      if (parent)
        edges.push({ parent, child: id, kind: spawn ? "spawned" : "forked" });
      if (provider === "claude")
        for (const entry of await entries(
          path.join(path.dirname(file), native, "subagents"),
        )) {
          if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
          const childFile = path.join(
            path.dirname(file),
            native,
            "subagents",
            entry.name,
          );
          const cm = await stat(childFile);
          if (cm.mtimeMs < start) continue;
          const ce = await events(childFile),
            cid = native + ":" + entry.name.slice(0, -6);
          sessionLogs.set(cid, childFile);
          const first = ce.rows.find((r) => r.type === "user");
          add({
            id: cid,
            nativeId: entry.name.slice(0, -6),
            provider,
            title:
              clean(extractText({ ...first, isSidechain: false })) ||
              "Claude subagent",
            project: path.basename(cwd) || "Workspace",
            cwd,
            updated: new Date(cm.mtimeMs).toISOString(),
            lastRequest: clean(extractText(first || {})),
            ...messageTimes(ce.rows),
            parent: id,
            child: true,
            ...logStatus(ce.rows, provider, now),
            inclusion: "Child session",
            sampled: ce.sampled,
            userTurns: ce.rows.filter(
              (r) => r.type === "user" && r.message?.content,
            ).length,
            messageCount: ce.rows.filter((r) =>
              ["user", "assistant"].includes(r.type),
            ).length,
          });
          edges.push({ parent: id, child: cid, kind: "spawned" });
        }
    } catch {
      warnings.push("A changing session log could not be read.");
    }
  }
  // Live Claude metadata is read only from the configured source's sibling sessions directory.
  for (const e of await entries(
    path.join(path.dirname(config.source), "sessions"),
  )) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    try {
      const live = JSON.parse(
          await readFile(
            path.join(path.dirname(config.source), "sessions", e.name),
            "utf8",
          ),
        ),
        s = sessions.get(live.sessionId);
      if (!s) continue;
      if (
        typeof live.hostSessionId === "string" &&
        /^local_[0-9a-f-]{36}$/i.test(live.hostSessionId)
      )
        s.hostSessionId = live.hostSessionId;
      process.kill(live.pid, 0);
      Object.assign(s, withLiveStatus(s, live));
      if (live.name) s.title = clean(live.name);
    } catch {}
  }
  const desktopSessions = await claudeDesktopSessions(home);
  for (const s of sessions.values()) {
    if (s.provider !== "claude" || s.hostSessionId) continue;
    const recorded = desktopSessions.get(s.nativeId);
    if (recorded) s.hostSessionId = recorded.hostSessionId;
  }
  const launches = [],
    parentMetadata = new Map();
  for (const file of claude) {
    try {
      if ((await stat(file)).mtimeMs < start) continue;
      const evidence = await readClaudeLaunches(file);
      parentMetadata.set(evidence.id, evidence);
      launches.push(...evidence.launches);
    } catch {}
  }
  for (const session of sessions.values()) {
    if (session.provider !== "codex" || session.parent) continue;
    const launch = matchClaudeLaunch(session, launches);
    if (!launch) continue;
    const parent =
      sessions.get(launch.parent) || parentMetadata.get(launch.parent);
    if (!parent) continue;
    if (!sessions.has(launch.parent))
      sessions.set(launch.parent, {
        id: launch.parent,
        nativeId: launch.parent,
        provider: "claude",
        title: parent.title || "Parent Claude session",
        cwd: parent.cwd,
        project: path.basename(parent.cwd) || "Workspace",
        updated: new Date(launch.at).toISOString(),
        status: "unknown",
        basis: "Parent of a delegated session today",
        statusAt: null,
        lastRequest: "",
        inclusion: "Parent of today's session",
        child: false,
      });
    session.parent = launch.parent;
    session.child = true;
    session.originEvidence = launch.evidence;
    const label = launchTitle(launch.label);
    if (label) session.title = label;
    edges.push({
      parent: launch.parent,
      child: session.id,
      kind: "delegated",
      evidence: launch.evidence,
    });
  }
  const rewoundSessions = coalesceClaudeRewinds(
    sessions,
    edges,
    desktopSessions,
  );
  linkSharedHistory(sessions, edges);
  for (const session of sessions.values()) {
    session.originalTitle ||= session.title;
    session.title = conversationName(
      session.title,
      session.project,
      session._prompt,
    );
    if (session._created > 0)
      session.startedAt = new Date(session._created).toISOString();
    delete session._prompt;
    delete session._created;
  }
  const ids = new Set(sessions.keys());
  for (const e of edges)
    if (isFamilyEdge(e) && ids.has(e.parent) && sessions.has(e.child)) {
      sessions.get(e.child).child = true;
      sessions.get(e.child).parent = e.parent;
    }
  for (const e of edges)
    if (!isFamilyEdge(e)) {
      const s = sessions.get(e.child);
      if (s?.parent === e.parent) {
        s.parent = null;
        s.child = false;
      }
    }
  return {
    rewoundSessions: [...rewoundSessions.keys()],
    sessions: [...sessions.values()],
    edges: [
      ...new Map(
        edges
          .filter(
            (e) =>
              e.parent !== e.child && ids.has(e.parent) && ids.has(e.child),
          )
          .map((e) => [e.parent + ">" + e.child, e]),
      ).values(),
    ],
    sources,
    warnings: [...new Set(warnings)],
  };
}
// Compatibility export: all membership now comes from the saved stream catalogue.
export function attachSemantics(db, sessions, model) {
  return attachTodayStreams(db, sessions);
}
export function mountToday(app, db, { discover = discoverToday } = {}) {
  app.use("/api/today", (req, res, next) => {
    if (req.method === "POST" && !req.is("application/json"))
      return res.status(415).json({ error: "Use application/json." });
    next();
  });
  app.post("/api/today/sessions/search", (req, res, next) => {
    try {
      res.json(sessionOptions(db, req.body));
    } catch (error) {
      next(error);
    }
  });
  const service = createTodayService(db, { actor: "user" });
  app.get("/api/today/tasks/:taskId/images/:attachmentId", (req, res, next) => {
    try {
      const image = service.readTaskImage(req.params);
      res.setHeader("Content-Type", "image/png");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");
      res.send(Buffer.from(image.data, "base64"));
    } catch (e) {
      next(e);
    }
  });
  const brief = createSessionBrief(db);
  let lastSnapshot = null;
  function currentSession(id) {
    const session = lastSnapshot?.sessions.find((s) => s.id === id);
    if (!session)
      throw Object.assign(Error("Refresh Today before opening this session."), {
        status: 404,
      });
    return session;
  }
  async function sessionMessages(ids) {
    const messages = [];
    for (const session of ids) {
      const file = sessionLogs.get(session);
      if (!file) continue;
      const { rows } = await events(file);
      for (const r of rows) {
        const text = extractText({ ...r, isSidechain: false });
        const role = r.type === "response_item" ? r.payload?.role : r.type;
        if (text && ["user", "assistant"].includes(role))
          messages.push({ session, role, timestamp: r.timestamp, text });
      }
    }
    return messages;
  }
  app.post("/api/today/sessions/suggest-title", async (req, res, next) => {
    try {
      const session = currentSession(req.body?.session);
      const file = sessionLogs.get(session.id);
      let messages = [];
      if (file) {
        try {
          messages = await readSessionTitleEvidence(file, session.id);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      if (!messages.length) {
        const sampler = titleEvidenceSampler(session.id);
        for (const row of db
          .prepare(
            "SELECT session,role,timestamp,text FROM chunks WHERE session=? AND role IN ('user','assistant')",
          )
          .iterate(session.id))
          sampler.add(row);
        messages = sampler.messages();
      }
      res.json(
        await suggestSessionTitle({
          session: session.id,
          title: session.title,
          model: getConfig(db).generationModel,
          messages,
          force: req.body?.force === true,
        }),
      );
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/today/sessions/rename", (req, res, next) => {
    try {
      const session = currentSession(req.body?.session);
      res.json(saveSessionTitle(db, session.id, req.body?.title));
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/today/brief", async (req, res, next) => {
    try {
      const id = req.body?.session;
      currentSession(id);
      const forest = familyRoots(lastSnapshot.sessions, lastSnapshot.edges);
      const ids = lastSnapshot.sessions
        .filter((s) => {
          let p = s.id;
          while (p) {
            if (p === id) return true;
            p = forest.parent.get(p);
          }
          return false;
        })
        .map((s) => s.id);
      const messages = await sessionMessages(ids);
      const streaming = req.body?.stream === true;
      const send = (data) => {
        if (!res.destroyed) res.write(JSON.stringify(data) + "\n");
      };
      if (streaming) {
        startNDJSON(res);
      }
      const result = await brief({
        session: id,
        model: getConfig(db).generationModel,
        messages,
        onToken: streaming
          ? (text) => send({ event: "summary", text })
          : undefined,
      });
      if (streaming) {
        send({ event: "done", ...result });
        res.end();
      } else res.json(result);
    } catch (e) {
      if (res.headersSent) {
        if (!res.destroyed)
          res.end(JSON.stringify({ event: "error", error: e.message }) + "\n");
      } else next(e);
    }
  });
  let cached = null,
    at = 0,
    inflight = null;
  app.get("/api/today", async (req, res, next) => {
    try {
      const now = Date.now(),
        start = Date.parse(req.query.start),
        end = Date.parse(req.query.end);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start ||
        end - start > 27 * 3600000
      )
        throw Object.assign(new Error("Supply a local-day start and end."), {
          status: 400,
        });
      const config = getConfig(db),
        key = JSON.stringify([start, end, config.source, config.codexSource]);
      if (!cached || cached.key !== key || now - at > 2500) {
        if (!inflight)
          inflight = discover(config, { start, end, now })
            .then((value) => {
              cached = { key, value };
              at = Date.now();
            })
            .finally(() => (inflight = null));
        await inflight;
        if (cached.key !== key) {
          cached = {
            key,
            value: await discover(config, { start, end, now }),
          };
          at = Date.now();
        }
      }
      const value = structuredClone(cached.value),
        byId = new Map(value.sessions.map((s) => [s.id, s])),
        rewoundSessions = new Set(value.rewoundSessions);
      delete value.rewoundSessions;
      // Indexed user activity fills gaps in sampled logs without triggering import or embedding.
      for (const r of db
        .prepare(
          "SELECT session,provider,title,project,max(timestamp) AS updated FROM chunks WHERE role='user' AND timestamp>=? AND timestamp<? GROUP BY session",
        )
        .all(new Date(start).toISOString(), new Date(end).toISOString())) {
        if (rewoundSessions.has(r.session)) continue;
        if (!byId.has(r.session)) {
          const s = {
            id: r.session,
            nativeId: r.session.replace(/^codex:/, ""),
            provider: r.provider,
            title: r.title,
            project: r.project,
            updated: r.updated,
            lastRequest: "",
            status: "unknown",
            basis: "Indexed history only; live state unavailable",
            statusAt: null,
            child: false,
            inclusion: "User interaction today",
          };
          byId.set(s.id, s);
        } else byId.get(r.session).inclusion = "User interaction today";
      }
      for (const r of db
        .prepare("SELECT * FROM today_events WHERE updated>=? AND updated<?")
        .all(new Date(start).toISOString(), new Date(end).toISOString())) {
        if (rewoundSessions.has(r.session)) continue;
        const e = JSON.parse(r.data),
          fresh = now - Date.parse(r.updated) < 180000,
          s = byId.get(e.session) || {
            id: e.session,
            nativeId: e.session.replace(/^codex:/, ""),
            provider: e.provider,
            title: e.title,
            project: e.project,
            lastRequest: "",
            updated: r.updated,
            child: !!e.parent,
            parent: e.parent,
            inclusion: "Agent-reported activity",
          };
        if (
          (fresh &&
            !s.pendingInput &&
            !(s.waitingOnBackground && e.status === "done") &&
            Date.parse(r.updated) >= (Date.parse(s.statusAt) || 0)) ||
          !s.status
        )
          Object.assign(s, {
            status: fresh ? e.status : "unknown",
            basis: fresh ? "Agent-reported status" : "Agent heartbeat expired",
            statusAt: r.updated,
          });
        byId.set(e.session, s);
        if (e.parent && byId.has(e.parent))
          value.edges.push({
            parent: e.parent,
            child: e.session,
            kind: "spawned",
          });
      }
      value.sessions = [...byId.values()].sort(
        (a, b) => Date.parse(b.updated) - Date.parse(a.updated),
      );
      for (const r of db
        .prepare(
          "SELECT DISTINCT session,timestamp FROM chunks WHERE role='user' AND timestamp>=? AND timestamp<?",
        )
        .all(new Date(start).toISOString(), new Date(end).toISOString())) {
        const s = byId.get(r.session);
        if (s && !s.activity) {
          s.activity = [];
          s._indexedActivity = true;
        }
        if (s?._indexedActivity)
          s.activity.push({ id: "indexed:" + r.timestamp, at: r.timestamp });
      }
      for (const s of value.sessions) delete s._indexedActivity;
      const displayName = sessionNameResolver(db);
      for (const s of value.sessions) {
        s.originalTitle ||= s.title;
        s.title = displayName(s.id, s.originalTitle, s.project, s.lastRequest);
      }
      attachFamilyPreferences(db, value.sessions, value.edges);
      const semantics = attachTodayStreams(db, value.sessions, value.edges);
      disambiguateSessionTitles(value.sessions);
      attachUnread(db, value.sessions, start, end);
      lastSnapshot = value;
      const activity = streamActivity(value.sessions, start, end);
      res.json({
        ...value,
        ...semantics,
        workstreams: semantics.workstreams.map((s) => ({
          ...s,
          activity: activity.get(s.id),
        })),
        visibility: readTodayVisibility(db),
        ...service.listTasks(),
        positions: db
          .prepare("SELECT session AS id,x,y,pinned FROM today_card_layout")
          .all()
          .filter((p) => byId.has(p.id))
          .map((p) => ({ ...p, pinned: !!p.pinned })),
        refreshed: new Date().toISOString(),
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
      });
    } catch (e) {
      next(e);
    }
  });
  for (const [route, method] of [
    ["tasks/list", "listTasks"],
    ["tasks/create", "createTask"],
    ["tasks/update", "updateTask"],
    ["tasks/delete", "deleteTask"],
    ["session", "reportSession"],
  ])
    app.post("/api/today/" + route, (req, res, next) => {
      try {
        res.json(service[method](req.body || {}));
      } catch (e) {
        next(e);
      }
    });
  app.post("/api/today/read", (req, res, next) => {
    try {
      res.json(markSessionRead(db, req.body || {}));
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/today/visibility", (req, res, next) => {
    try {
      res.json(setTodayVisibility(db, req.body || {}));
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/today/family", (req, res, next) => {
    try {
      currentSession(req.body?.session);
      res.json(
        setFamilyDetached(
          db,
          req.body,
          lastSnapshot.sessions,
          lastSnapshot.edges,
        ),
      );
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/today/layout", (req, res, next) => {
    try {
      res.json(saveTodayLayout(db, req.body || {}));
    } catch (e) {
      next(e);
    }
  });
}
