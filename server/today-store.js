import { taskImages, planTaskImages, saveTaskImages } from "./task-images.js";
import { activeAnalysis } from "./analysis-store.js";
import { randomUUID } from "node:crypto";
export function initTodaySchema(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS today_reads(session TEXT PRIMARY KEY,response_at TEXT NOT NULL)",
  );
  db.exec(`CREATE TABLE IF NOT EXISTS today_task_images(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,name TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,data BLOB NOT NULL);
  CREATE INDEX IF NOT EXISTS today_task_images_task ON today_task_images(task_id);
  CREATE TABLE IF NOT EXISTS today_tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,notes TEXT NOT NULL,status TEXT NOT NULL,project TEXT NOT NULL,sessions TEXT NOT NULL,revision INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS today_visibility(kind TEXT NOT NULL,id TEXT NOT NULL,label TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(kind,id));
  CREATE TABLE IF NOT EXISTS today_events(session TEXT PRIMARY KEY,data TEXT NOT NULL,updated TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS today_card_layout(session TEXT PRIMARY KEY,x REAL NOT NULL,y REAL NOT NULL,pinned INTEGER NOT NULL);`);
  db.exec(
    "CREATE TABLE IF NOT EXISTS today_family_preferences(session TEXT PRIMARY KEY,detached INTEGER NOT NULL,updated TEXT NOT NULL)",
  );
  if (
    !db
      .prepare("PRAGMA table_info(today_tasks)")
      .all()
      .some((c) => c.name === "stream_id")
  )
    db.exec("ALTER TABLE today_tasks ADD COLUMN stream_id INTEGER");
  if (
    !db
      .prepare("PRAGMA table_info(today_tasks)")
      .all()
      .some((c) => c.name === "created_by")
  )
    db.exec(
      "ALTER TABLE today_tasks ADD COLUMN created_by TEXT NOT NULL DEFAULT 'unknown'",
    );
  if (
    !db
      .prepare("PRAGMA table_info(today_tasks)")
      .all()
      .some((c) => c.name === "created_session")
  )
    db.exec("ALTER TABLE today_tasks ADD COLUMN created_session TEXT");
  if (
    !db
      .prepare("PRAGMA table_info(today_tasks)")
      .all()
      .some((c) => c.name === "suspended")
  )
    db.exec(
      "ALTER TABLE today_tasks ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0",
    );
}
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};
const string = (value, max, name) => {
  if (typeof value !== "string" || value.length > max) fail(`Invalid ${name}`);
  return value.trim();
};
const permitted = (project, allowed) =>
  allowed === null || allowed.includes(project);
const taskRow = (r) => {
  if (!r) return null;
  const { stream_id, created_by, created_session, ...rest } = r;
  return {
    ...rest,
    streamId: stream_id ?? null,
    createdBy: created_by ?? "unknown",
    createdSession: created_session ?? null,
    suspended: !!r.suspended,
    sessions: JSON.parse(r.sessions),
  };
};
export function createTodayService(
  db,
  {
    allowedProjects = null,
    actor = "unknown",
    creatorSession = null,
    workingSession = null,
  } = {},
) {
  if (!["user", "ai", "unknown"].includes(actor))
    throw Error("Invalid task creator.");
  const checkProject = (p) => {
    if (!permitted(p, allowedProjects)) fail("Project is not permitted.", 403);
  };
  const linkedProject = (sid) => {
    const row = db
      .prepare("SELECT project FROM chunks WHERE session=? LIMIT 1")
      .get(sid);
    const event = db
      .prepare("SELECT data FROM today_events WHERE session=?")
      .get(sid);
    return row?.project ?? (event ? JSON.parse(event.data).project : null);
  };
  const canReadTask = (task) =>
    permitted(task.project, allowedProjects) &&
    (allowedProjects === null ||
      [
        ...task.sessions,
        ...(task.createdSession ? [task.createdSession] : []),
      ].every((sid) => {
        const project = linkedProject(sid);
        return project !== null && permitted(project, allowedProjects);
      }));
  const readTask = (row) => {
    const task = taskRow(row);
    return task ? { ...task, attachments: taskImages(db, task.id) } : null;
  };
  const listTasks = ({ includeSuspended = false } = {}) => ({
    tasks: db
      .prepare("SELECT * FROM today_tasks ORDER BY created")
      .all()
      .map(readTask)
      .filter(canReadTask)
      .filter((task) => actor !== "ai" || includeSuspended || !task.suspended),
  });
  function validate(body, old) {
    const title = string(body.title ?? old?.title ?? "", 300, "title");
    if (!title) fail("Enter a task title.");
    const notes = string(body.notes ?? old?.notes ?? "", 4000, "notes");
    const project = string(body.project ?? old?.project ?? "", 200, "project");
    checkProject(project);
    const status = body.status ?? old?.status ?? "todo";
    const suspended = body.suspended ?? old?.suspended ?? false;
    if (typeof suspended !== "boolean") fail("Invalid suspended flag.");
    if (actor === "ai" && body.suspended !== undefined)
      fail("Only the user can suspend or resume a task.", 403);
    if (!["todo", "doing", "done"].includes(status))
      fail("Invalid task status.");
    const sessions = body.sessions ?? old?.sessions ?? [];
    if (
      !Array.isArray(sessions) ||
      sessions.length > 20 ||
      sessions.some((s) => typeof s !== "string" || !s || s.length > 200)
    )
      fail("Invalid session links.");
    for (const sid of sessions) {
      const row = db
        .prepare("SELECT project FROM chunks WHERE session=? LIMIT 1")
        .get(sid);
      const event = db
        .prepare("SELECT data FROM today_events WHERE session=?")
        .get(sid);
      const linkedProject =
        row?.project ?? (event ? JSON.parse(event.data).project : null);
      if (linkedProject !== null) checkProject(linkedProject);
      else if (allowedProjects !== null) fail("Unknown session link.", 403);
    }
    const streamId =
      body.streamId === undefined ? (old?.streamId ?? null) : body.streamId;
    if (streamId !== null) {
      if (!Number.isSafeInteger(streamId) || streamId < 1)
        fail("Invalid work stream.");
      const run = activeAnalysis(db);
      if (
        streamId !== old?.streamId &&
        (!run ||
          !db
            .prepare("SELECT 1 FROM analysis_topics WHERE version=? AND id=?")
            .get(run.id, streamId))
      )
        fail("Work stream not found.", 404);
    }
    return {
      title,
      notes,
      project,
      status,
      suspended,
      streamId,
      sessions: [...new Set(sessions)],
    };
  }
  function createTask(body) {
    if (creatorSession !== null) {
      string(creatorSession, 200, "creator session");
      const project = linkedProject(creatorSession);
      if (project === null)
        fail("Report the creating session before creating a task.");
      checkProject(project);
    }
    const value = validate(body),
      now = new Date().toISOString(),
      id = randomUUID();
    const images = planTaskImages(db, id, body.attachments);
    db.prepare(
      "INSERT INTO today_tasks(id,title,notes,status,project,sessions,revision,created,updated,stream_id,created_by,created_session,suspended) VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?)",
    ).run(
      id,
      value.title,
      value.notes,
      value.status,
      value.project,
      JSON.stringify(value.sessions),
      now,
      now,
      value.streamId,
      actor,
      creatorSession,
      Number(value.suspended),
    );
    saveTaskImages(db, id, images);
    return {
      task: readTask(
        db.prepare("SELECT * FROM today_tasks WHERE id=?").get(id),
      ),
    };
  }
  function updateTask(body) {
    const id = string(body.id, 200, "task ID"),
      old = taskRow(db.prepare("SELECT * FROM today_tasks WHERE id=?").get(id));
    if (!old || !canReadTask(old)) fail("Task not found.", 404);
    if (actor === "ai" && old.suspended)
      fail(
        "This task is suspended. The user must resume it before agent work continues.",
        403,
      );
    if (!Number.isInteger(body.revision) || body.revision < 1)
      fail("Supply the task revision.");
    // The MCP channel supplies the reported working session, never the task
    // payload. Add it only on pickup, preserving other sessions and provenance.
    let update = body;
    if (actor === "ai" && body.status === "doing" && workingSession) {
      string(workingSession, 200, "working session");
      const project = linkedProject(workingSession);
      if (project === null)
        fail("Report the working session before picking up a task.");
      checkProject(project);
      update = {
        ...body,
        sessions: [
          ...new Set([...(body.sessions ?? old.sessions), workingSession]),
        ],
      };
    }
    const value = validate(update, old);
    const images = planTaskImages(db, id, body.attachments);
    const result = db
      .prepare(
        "UPDATE today_tasks SET title=?,notes=?,status=?,project=?,sessions=?,stream_id=?,suspended=?,revision=revision+1,updated=? WHERE id=? AND revision=?",
      )
      .run(
        value.title,
        value.notes,
        value.status,
        value.project,
        JSON.stringify(value.sessions),
        value.streamId,
        Number(value.suspended),
        new Date().toISOString(),
        id,
        body.revision,
      );
    if (!result.changes)
      fail(
        "This task changed in another session. Reload it before saving.",
        409,
      );
    saveTaskImages(db, id, images);
    return {
      task: readTask(
        db.prepare("SELECT * FROM today_tasks WHERE id=?").get(id),
      ),
    };
  }
  function reportSession(body) {
    const session = string(body.session, 200, "session ID");
    if (!session) fail("Session ID required.");
    const project = string(body.project ?? "", 200, "project");
    checkProject(project);
    const existing = db
      .prepare("SELECT project FROM chunks WHERE session=? LIMIT 1")
      .get(session);
    if (existing) checkProject(existing.project);
    const previousProject = linkedProject(session);
    if (previousProject !== null) checkProject(previousProject);
    if (
      !["claude", "codex"].includes(body.provider) ||
      !["running", "needs_input", "idle", "done", "error"].includes(body.status)
    )
      fail("Invalid provider or status.");
    if (body.provider === "codex" && !session.startsWith("codex:"))
      fail("Codex session IDs must start with codex:.");
    const title = string(body.title ?? session, 200, "title");
    const parent = body.parent ? string(body.parent, 200, "parent ID") : null;
    if (parent === session) fail("A session cannot parent itself.");
    if (parent && allowedProjects !== null) {
      const row = db
        .prepare("SELECT project FROM chunks WHERE session=? LIMIT 1")
        .get(parent);
      if (!row || !permitted(row.project, allowedProjects))
        fail("Parent is not permitted.", 403);
    }
    const now = new Date().toISOString();
    db.prepare("INSERT OR REPLACE INTO today_events VALUES(?,?,?)").run(
      session,
      JSON.stringify({
        session,
        project: existing?.project ?? previousProject ?? project,
        provider: body.provider,
        status: body.status,
        title,
        parent,
      }),
      now,
    );
    return {
      ok: true,
      expiresAt: new Date(Date.parse(now) + 180000).toISOString(),
    };
  }
  function deleteTask(body) {
    const id = string(body.id, 200, "task ID"),
      old = taskRow(db.prepare("SELECT * FROM today_tasks WHERE id=?").get(id));
    if (!old || !canReadTask(old)) fail("Task not found.", 404);
    if (actor === "ai" && old.suspended)
      fail(
        "This task is suspended. The user must resume it before agent work continues.",
        403,
      );
    if (!Number.isInteger(body.revision) || body.revision < 1)
      fail("Supply the task revision.");
    const result = db
      .prepare("DELETE FROM today_tasks WHERE id=? AND revision=?")
      .run(id, body.revision);
    if (!result.changes)
      fail(
        "This task changed in another session. Reopen it before deleting.",
        409,
      );
    db.prepare("DELETE FROM today_task_images WHERE task_id=?").run(id);
    return { deleted: true, id };
  }
  function readTaskImage({ taskId, attachmentId }) {
    const task = taskRow(
      db
        .prepare("SELECT * FROM today_tasks WHERE id=?")
        .get(string(taskId, 200, "task ID")),
    );
    if (!task || !canReadTask(task)) fail("Task not found.", 404);
    const image = db
      .prepare("SELECT * FROM today_task_images WHERE task_id=? AND id=?")
      .get(taskId, string(attachmentId, 200, "image ID"));
    if (!image) fail("Image not found.", 404);
    return {
      id: image.id,
      taskId,
      name: image.name,
      mimeType: "image/png",
      data: Buffer.from(image.data).toString("base64"),
    };
  }
  const atomic = (operation) => (body) => {
    db.exec("SAVEPOINT task_mutation");
    try {
      const result = operation(body);
      db.exec("RELEASE task_mutation");
      return result;
    } catch (e) {
      db.exec("ROLLBACK TO task_mutation; RELEASE task_mutation");
      throw e;
    }
  };
  return {
    listTasks,
    createTask: atomic(createTask),
    updateTask: atomic(updateTask),
    deleteTask: atomic(deleteTask),
    readTaskImage,
    reportSession,
  };
}
export function saveTodayLayout(db, body) {
  if (!Array.isArray(body.positions) || body.positions.length > 1000)
    fail("Invalid positions.");
  for (const p of body.positions)
    if (
      typeof p.id !== "string" ||
      p.id.length > 200 ||
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.y) ||
      Math.abs(p.x) > 1e6 ||
      Math.abs(p.y) > 1e6 ||
      typeof p.pinned !== "boolean"
    )
      fail("Invalid position.");
  const put = db.prepare(
    "INSERT OR REPLACE INTO today_card_layout VALUES(?,?,?,?)",
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const p of body.positions) put.run(p.id, p.x, p.y, Number(p.pinned));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { ok: true };
}

export function readTodayVisibility(db) {
  return db
    .prepare(
      "SELECT kind,id,label,updated FROM today_visibility ORDER BY updated DESC,kind,id",
    )
    .all();
}
export function setTodayVisibility(db, body) {
  if (!["session", "stream"].includes(body.kind))
    fail("Invalid visibility kind.");
  const id = string(body.id, 200, "visibility ID");
  if (!id || (body.kind === "stream" && !/^[1-9]\d*$/.test(id)))
    fail("Invalid visibility ID.");
  if (typeof body.hidden !== "boolean") fail("Supply hidden as a boolean.");
  const label = string(body.label ?? id, 300, "visibility label");
  if (body.hidden)
    db.prepare(
      "INSERT INTO today_visibility(kind,id,label,updated) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET label=excluded.label,updated=excluded.updated",
    ).run(body.kind, id, label, new Date().toISOString());
  else
    db.prepare("DELETE FROM today_visibility WHERE kind=? AND id=?").run(
      body.kind,
      id,
    );
  return { visibility: readTodayVisibility(db) };
}
