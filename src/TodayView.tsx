import { ActionIcon, Button } from "@mantine/core";
import {
  Badge as CountBadge,
  Modal,
  ScrollArea,
  Drawer,
  SegmentedControl,
  Select,
  Stack,
  Tabs,
  Text,
  TextInput,
  Textarea,
  Group,
  Menu,
  UnstyledButton,
} from "@mantine/core";
import SessionPicker, { type SessionOption } from "./SessionPicker";
import Markdown from "./Markdown.js";
import { sessionOpenLink } from "../shared/session-links.js";
import {
  compareStreamActivity,
  focusedSessions,
  todayStatusCounts,
  relevantArchives,
  openTaskStreamIds,
  compareTasks,
} from "../shared/today-focus.js";
import TodayBoards from "./TodayBoards";
import SessionBrief from "./SessionBrief";
import SessionRename from "./SessionRename";
import TaskImages, { pastedImages, type TaskImage } from "./TaskImages";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowUpRight,
  PanelRight,
  Check,
  ChevronDown,
  CircleHelp,
  Copy,
  Network,
  Plus,
  Pencil,
  Sparkles,
  UserRound,
  RefreshCw,
  Search,
  X,
  Trash2,
  Paperclip,
  Ellipsis,
  Pause,
  Play,
  Link2,
  Unlink2,
} from "lucide-react";
import { api, type SyncJob } from "./api";
import { SyncStatus, SyncWarnings, syncPhases } from "./SyncProgress";
import { notify } from "./ui/notify";
import { sessionReadTargets } from "../shared/session-read.js";
import { familyRoots, isFamilyEdge } from "../shared/today-layout.js";
import {
  displaySessionStatus,
  statusLabels,
  statusColors,
} from "../shared/session-status-display.js";
import "./today.css";
type SessionStatus = Parameters<typeof displaySessionStatus>[0];
export type Session = {
  id: string;
  nativeId: string;
  hostSessionId?: string;
  provider: "claude" | "codex";
  title: string;
  project: string;
  cwd?: string;
  updated: string;
  lastResponseAt?: string;
  unread?: boolean;
  startedAt?: string;
  sameTitle?: boolean;
  lastRequest: string;
  status: SessionStatus;
  basis: string;
  statusAt: string | null;
  parent?: string;
  child: boolean;
  inclusion: string;
  sampled?: boolean;
  userTurns?: number;
  messageCount?: number;
  originEvidence?: string;
  relationship?: "shared_history";
  historyFamily?: string;
  branchRequest?: string;
  originalTitle?: string;
  streamIds?: number[];
  boardStreamId?: number | null;
  topic?: { id: string; name: string; color: string };
  familyDetached?: boolean;
  familyLink?: { parent: string; kind: string; detached: boolean };
};
type Position = { id: string; x: number; y: number; pinned: boolean };
type Task = {
  suspended?: boolean;
  attachments?: TaskImage[];
  createdBy?: "user" | "ai" | "unknown";
  createdSession?: string | null;
  streamId: number | null;
  id: string;
  title: string;
  notes: string;
  project: string;
  status: "todo" | "doing" | "done";
  sessions: string[];
  revision: number;
  created: string;
  updated: string;
};
export type HiddenItem = {
  kind: "session" | "stream";
  id: string;
  label: string;
};
export type Snapshot = {
  visibility?: HiddenItem[];
  sessions: Session[];
  edges: { parent: string; child: string; kind: string }[];
  semantic: { a: string; b: string; score: number }[];
  topics: { id: string; name: string; color: string }[];
  positions: Position[];
  tasks: Task[];
  warnings: string[];
  sources: { claude: string; codex: string };
  refreshed: string;
  start: string;
  end: string;
  catalogueReady?: boolean;
  streamsUpdatedAt?: string | null;
  unclassifiedSessions?: number;
  taskWorkstreams?: {
    id: number;
    name: string;
    description: string;
    color: string;
  }[];
  workstreams?: {
    id: number;
    name: string;
    description: string;
    activity?: { periods: number; requests: number; latest: number };
    color: string;
    background: boolean;
  }[];
  higherStreams?: {
    id: number;
    name: string;
    color: string;
    topicIds: number[];
  }[];
  analysisVersion: string | null;
};
const columns = [
  ["todo", "To do"],
  ["doing", "In progress"],
  ["done", "Done"],
] as const;
function TaskOrigin({
  origin = "unknown",
  detailed = false,
}: {
  origin?: Task["createdBy"];
  detailed?: boolean;
}) {
  if (origin !== "user" && origin !== "ai") return null;
  const label =
    origin === "user"
      ? detailed
        ? "Added by you"
        : "You"
      : detailed
        ? "Added by AI"
        : "AI";
  return (
    <span
      className={"td-task-origin " + origin}
      title={origin === "user" ? "Added by you" : "Added by AI"}
    >
      {origin === "user" ? <UserRound size={12} /> : <Sparkles size={12} />}
      {label}
    </span>
  );
}
function dayScope() {
  const d = new Date(),
    start = new Date(d.getFullYear(), d.getMonth(), d.getDate()),
    end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return new URLSearchParams({
    start: start.toISOString(),
    end: end.toISOString(),
  }).toString();
}
function age(value: string) {
  const s = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  return s < 60
    ? "just now"
    : s < 3600
      ? `${Math.floor(s / 60)}m ago`
      : s < 86400
        ? `${Math.floor(s / 3600)}h ago`
        : new Date(value).toLocaleDateString("en-GB");
}
function Badge({ status }: { status: SessionStatus }) {
  return (
    <span className={"td-badge " + displaySessionStatus(status)}>
      <i style={{ background: statusColors[displaySessionStatus(status)] }} />
      {statusLabels[displaySessionStatus(status)]}
    </span>
  );
}
export default function TodayView({
  onOpenStream,
  onAgentSetup,
  analysisJob,
  namingPending = false,
  autoSync,
}: {
  onOpenStream?: (
    id: number,
    scope?: { project: string; start: string; end: string },
  ) => void;
  onAgentSetup: () => void;
  analysisJob?: SyncJob;
  namingPending?: boolean;
  autoSync?: { paused: boolean; lastSuccessfulAt: string | null };
}) {
  const [data, setData] = useState<Snapshot | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [query, setQuery] = useState(""),
    [provider, setProvider] = useState("all"),
    [status, setStatus] = useState("all"),
    [showHidden, setShowHidden] = useState(false),
    [rebuilding, setRebuilding] = useState(false),
    [board, setBoard] = useState(true),
    [boardStream, setBoardStream] = useState<number | "all">("all"),
    [taskStream, setTaskStream] = useState<number | "">(""),
    [selected, setSelected] = useState<string | null>(null),
    [edit, setEdit] = useState<Task | null>(null),
    [taskMode, setTaskMode] = useState<"view" | "edit">("view"),
    [taskOpened, setTaskOpened] = useState(false),
    [deleteTarget, setDeleteTarget] = useState<Task | null>(null),
    [helpOpened, setHelpOpened] = useState(false),
    [taskError, setTaskError] = useState(""),
    [taskLinkOptions, setTaskLinkOptions] = useState<SessionOption[]>([]),
    [saving, setSaving] = useState(false),
    [taskTitle, setTaskTitle] = useState(""),
    [taskNotes, setTaskNotes] = useState(""),
    [taskStatus, setTaskStatus] = useState<Task["status"]>("todo"),
    [taskProject, setTaskProject] = useState(""),
    [taskSessions, setTaskSessions] = useState<string[]>([]);
  const imageEditEpoch = useRef(0);
  const [taskImages, setTaskImages] = useState<TaskImage[]>([]);
  const [imagesLoading, setImagesLoading] = useState(false);
  const analysisBusy = !!analysisJob && syncPhases.includes(analysisJob.phase);
  const inflight = useRef(false),
    taskEpoch = useRef(0),
    readResponses = useRef(new Map<string, string>()),
    pendingRefresh = useRef(false),
    mounted = useRef(true);
  async function refresh(force = false) {
    if (inflight.current) {
      if (force) pendingRefresh.current = true;
      return;
    }
    inflight.current = true;
    const requestedEpoch = taskEpoch.current;
    setLoading(true);
    try {
      const scope = dayScope(),
        next = await api<Snapshot>("today?" + scope);
      if (!mounted.current) return;
      for (const s of next.sessions) {
        const read = readResponses.current.get(s.id);
        if (read && s.lastResponseAt && s.lastResponseAt <= read)
          s.unread = false;
      }
      // A slow native-session scan must not undo a task mutation acknowledged
      // while this older snapshot was in flight.
      setData((current) =>
        current && requestedEpoch !== taskEpoch.current
          ? { ...next, tasks: current.tasks }
          : next,
      );
      setError("");
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      inflight.current = false;
      if (mounted.current) {
        setLoading(false);
        if (pendingRefresh.current) {
          pendingRefresh.current = false;
          void refresh();
        }
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 3000);
    const show = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", show);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", show);
    };
  }, []);
  const [archiveSession, setArchiveSession] = useState<Session | null>(null);
  const [imageOverlayOpen, setImageOverlayOpen] = useState(false);
  const [briefSession, setBriefSession] = useState<string | null>(null);
  const [renameSession, setRenameSession] = useState<string | null>(null);
  useEffect(() => setRenameSession(null), [selected]);
  const allSessions = data?.sessions || [],
    archived = relevantArchives(
      allSessions,
      data?.visibility || [],
    ) as HiddenItem[],
    sessions = useMemo(
      () =>
        focusedSessions(
          allSessions,
          data?.edges || [],
          data?.visibility || [],
        ) as Session[],
      [data],
    ),
    edgeList = data?.edges || [],
    byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [data]);
  const matches = (s: Session) =>
    (provider === "all" || s.provider === provider) &&
    (status === "all" ||
      (status === "unread" ? s.unread : s.status === status)) &&
    (!query ||
      `${s.title} ${s.project} ${s.provider}`
        .toLowerCase()
        .includes(query.toLowerCase()));
  const statusCounts = todayStatusCounts(
    allSessions,
    edgeList,
    data?.visibility || [],
  );
  const matched = sessions.filter(matches);
  const forest = familyRoots(sessions, edgeList);
  // Filter conversations as families so parent cards retain their disclosure
  // and completion controls when a search matches a parent or one of its children.
  const matchedRoots = new Set(matched.map((s) => forest.root(s.id)));
  const visible = sessions.filter((s) => matchedRoots.has(forest.root(s.id)));
  function selectSession(id: string) {
    setSelected(id);
    setBriefSession(null);
    const targets = sessionReadTargets(id, sessions, edgeList) as (Session & {
      lastResponseAt: string;
    })[];
    const ids = new Set(targets.map((s) => s.id));
    for (const s of targets) readResponses.current.set(s.id, s.lastResponseAt);
    setData((current) =>
      current
        ? {
            ...current,
            sessions: current.sessions.map((s) =>
              ids.has(s.id) ? { ...s, unread: false } : s,
            ),
          }
        : current,
    );
    for (const s of targets)
      void api("today/read", {
        session: s.id,
        responseAt: s.lastResponseAt,
      }).catch((e: Error) => {
        readResponses.current.delete(s.id);
        setError(e.message);
        void refresh();
      });
  }
  async function setVisibility(
    kind: HiddenItem["kind"],
    id: string,
    hidden: boolean,
    label: string,
  ) {
    try {
      await api("today/visibility", { kind, id, hidden, label });
      setData((old) =>
        old
          ? {
              ...old,
              visibility: [
                ...(old.visibility || []).filter(
                  (h) => !(h.kind === kind && h.id === id),
                ),
                ...(hidden ? [{ kind, id, label }] : []),
              ],
            }
          : old,
      );
      if (hidden) {
        setSelected(null);
      }
      notify(
        hidden
          ? "Archived from Today. Restore it from Archived whenever you want."
          : "Restored to Today.",
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function syncSessions() {
    setRebuilding(true);
    try {
      await api("sync", {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRebuilding(false);
    }
  }
  const selectedSession = selected
    ? allSessions.find((s) => s.id === selected) ||
      (archiveSession?.id === selected ? archiveSession : null)
    : null;
  const selectedDisplayParent = selectedSession
    ? forest.parent.get(selectedSession.id) || selectedSession.parent
    : null;
  async function setDetached(id: string, detached: boolean) {
    try {
      await api("today/family", { session: id, detached });
      setData((current) =>
        current
          ? {
              ...current,
              sessions: current.sessions.map((s) =>
                s.id === id
                  ? {
                      ...s,
                      familyDetached: detached,
                      familyLink: s.familyLink
                        ? { ...s.familyLink, detached }
                        : undefined,
                    }
                  : s,
              ),
            }
          : current,
      );
      await refresh(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const selectedTasks = selectedSession
    ? (data?.tasks || [])
        .filter((t) => t.sessions.includes(selectedSession.id))
        .sort(compareTasks)
    : [];
  const openSelectedTasks = selectedTasks.filter((t) => t.status !== "done");
  const completedSelectedTasks = selectedTasks.filter(
    (t) => t.status === "done",
  );
  const families = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const [child, parent] of forest.parent) {
      const s = byId.get(child);
      if (s) {
        const a = map.get(parent) || [];
        if (!a.some((x) => x.id === s.id)) a.push(s);
        map.set(parent, a);
      }
    }
    return map;
  }, [data]);
  const historyPeers = selectedSession
    ? sessions.filter(
        (s) =>
          s.id !== selectedSession.id &&
          edgeList.some(
            (e) =>
              !isFamilyEdge(e) &&
              ((e.parent === selectedSession.id && e.child === s.id) ||
                (e.child === selectedSession.id && e.parent === s.id)),
          ),
      )
    : [];
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify("Copied to clipboard.");
    } catch {
      setError("Clipboard access is unavailable. Select the text to copy it.");
    }
  }
  function openTask(
    task: Task | null = null,
    linked?: string,
    column: Task["status"] = "todo",
    editing = false,
  ) {
    imageEditEpoch.current++;
    setImagesLoading(false);
    setEdit(task);
    setDeleteTarget(null);
    setTaskError("");
    setTaskMode(task && !editing ? "view" : "edit");
    setTaskLinkOptions([]);
    setTaskTitle(task?.title || "");
    setTaskNotes(task?.notes || "");
    setTaskImages(task?.attachments || []);
    setTaskStatus(task?.status || column);
    setTaskProject(task?.project || "");
    setTaskStream(
      task
        ? (task.streamId ?? "")
        : linked
          ? (byId.get(linked)?.boardStreamId ?? "")
          : activeBoard === "all"
            ? ""
            : activeBoard,
    );
    setTaskSessions(task?.sessions || (linked ? [linked] : []));
    setTaskOpened(true);
  }
  async function addTaskImages(files: File[]) {
    const epoch = imageEditEpoch.current;
    setImagesLoading(true);
    setTaskError("");
    try {
      const images = await pastedImages(files);
      if (epoch !== imageEditEpoch.current) return;
      setTaskImages((old) => {
        if (
          old.length + images.length > 4 ||
          [...old, ...images].reduce((n, i) => n + (i.bytes || 0), 0) >
            8 * 1024 * 1024
        ) {
          setTaskError("Attach at most four PNGs, totalling at most 8 MB.");
          return old;
        }
        return [...old, ...images];
      });
    } catch (e) {
      setTaskError((e as Error).message);
    } finally {
      if (epoch === imageEditEpoch.current) setImagesLoading(false);
    }
  }
  async function saveTask(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setTaskError("");
    try {
      const value = {
        streamId: taskStream === "" ? null : taskStream,
        title: taskTitle,
        notes: taskNotes,
        attachments: taskImages,
        status: taskStatus,
        project: taskProject,
        sessions: taskSessions,
      };
      const { task } = await api<{ task: Task }>(
        edit ? "today/tasks/update" : "today/tasks/create",
        edit ? { ...value, id: edit.id, revision: edit.revision } : value,
      );
      acceptTask(task);
      setTaskOpened(false);
      void refresh(true);
      notify("Shared board updated.");
    } catch (e) {
      setTaskError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  function taskSession(id: string) {
    return (
      allSessions.find((s) => s.id === id) ||
      taskLinkOptions.find((s) => s.id === id) || {
        id,
        nativeId: id.replace(/^codex:/, ""),
        provider: id.startsWith("codex:")
          ? ("codex" as const)
          : ("claude" as const),
        title: "Earlier session",
        project: "",
      }
    );
  }
  async function openTaskSession(id: string) {
    const live = allSessions.find((s) => s.id === id);
    if (live) {
      setArchiveSession(null);
      setTaskOpened(false);
      selectSession(id);
      return;
    }
    try {
      const result = await api<{
        sessions: (SessionOption & { updated?: string })[];
      }>("today/sessions/search", { ids: [id] });
      const session = result.sessions.find((s) => s.id === id);
      if (!session)
        throw Error(
          "This session is no longer indexed. Its link is kept on the task.",
        );
      setArchiveSession({
        ...session,
        updated: session.updated || "",
        lastRequest: "",
        status: "unknown",
        statusAt: null,
        basis: "Archived conversation. Live activity is unavailable.",
        inclusion: "archive",
        child: !!session.parent,
      });
      setTaskOpened(false);
      setSelected(id);
      setBriefSession(null);
    } catch (error) {
      setTaskError((error as Error).message);
    }
  }
  async function saveAnnotatedImage(image: TaskImage) {
    if (!viewedTask) throw Error("Reopen the task before saving an image.");
    setSaving(true);
    try {
      const { task } = await api<{ task: Task }>("today/tasks/update", {
        id: viewedTask.id,
        revision: viewedTask.revision,
        attachments: [...(viewedTask.attachments || []), image],
      });
      acceptTask(task);
      void refresh(true);
      notify("Marked-up copy saved. Original kept.");
    } finally {
      setSaving(false);
    }
  }
  function acceptTask(task: Task) {
    taskEpoch.current++;
    setData((current) =>
      current
        ? {
            ...current,
            tasks: current.tasks.some((t) => t.id === task.id)
              ? current.tasks.map((t) => (t.id === task.id ? task : t))
              : [...current.tasks, task],
          }
        : current,
    );
  }
  async function deleteTask() {
    if (!deleteTarget) return;
    setSaving(true);
    setTaskError("");
    try {
      await api("today/tasks/delete", {
        id: deleteTarget.id,
        revision: deleteTarget.revision,
      });
      taskEpoch.current++;
      setData((current) =>
        current
          ? {
              ...current,
              tasks: current.tasks.filter((t) => t.id !== deleteTarget.id),
            }
          : current,
      );
      setDeleteTarget(null);
      setTaskOpened(false);
      void refresh(true);
      notify("Task deleted.");
    } catch (e) {
      setTaskError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function moveTask(task: Task, status: Task["status"]) {
    if (task.status === status) return;
    try {
      const { task: updated } = await api<{ task: Task }>(
        "today/tasks/update",
        {
          id: task.id,
          revision: task.revision,
          status,
        },
      );
      acceptTask(updated);
      void refresh(true);
    } catch (e) {
      setError((e as Error).message);
      await refresh(true);
    }
  }
  async function toggleTaskSuspension(task: Task) {
    setSaving(true);
    setTaskError("");
    try {
      const { task: updated } = await api<{ task: Task }>(
        "today/tasks/update",
        {
          id: task.id,
          revision: task.revision,
          suspended: !task.suspended,
        },
      );
      acceptTask(updated);
      void refresh(true);
      notify(
        updated.suspended
          ? "Task suspended. Agents will skip it."
          : "Task resumed.",
      );
    } catch (e) {
      setTaskError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const viewedTask = edit
    ? data?.tasks.find((t) => t.id === edit.id) || edit
    : null;
  const viewedLinks = JSON.stringify(
    taskMode === "view"
      ? [
          ...new Set([
            ...(viewedTask?.createdSession ? [viewedTask.createdSession] : []),
            ...(viewedTask?.sessions || []),
          ]),
        ]
      : [],
  );
  useEffect(() => {
    const ids = JSON.parse(viewedLinks) as string[];
    if (!ids.length) return;
    let live = true;
    void api<{ sessions: SessionOption[] }>("today/sessions/search", { ids })
      .then((result) => {
        if (live) setTaskLinkOptions(result.sessions);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [viewedLinks]);
  const taskStreamIds = openTaskStreamIds(data?.tasks || []);
  const taskStreams = [
    ...new Map(
      [...(data?.taskWorkstreams || []), ...(data?.workstreams || [])].map(
        (stream) => [stream.id, stream],
      ),
    ).values(),
  ]
    .filter(
      (s) => !("background" in s && s.background) || taskStreamIds.has(s.id),
    )
    .sort(compareStreamActivity);
  const boardStreams = taskStreams.filter((s) => taskStreamIds.has(s.id));
  const activeBoard =
    boardStream === "all" || boardStreams.some((s) => s.id === boardStream)
      ? boardStream
      : "all";
  const boardTasks = (data?.tasks || []).filter(
    (t) => activeBoard === "all" || t.streamId === activeBoard,
  );
  return (
    <div className="today-view">
      <header className="page-heading">
        <div className="page-intro">
          <h1>Today</h1>
          <p>
            {new Date().toLocaleDateString("en-GB", {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}{" "}
            · Your work streams, sessions and next steps.
          </p>
        </div>
        <div className="page-actions td-heading-actions">
          <ActionIcon
            variant="subtle"
            aria-label="How Today works"
            onClick={() => setHelpOpened(true)}
          >
            <CircleHelp size={18} />
          </ActionIcon>
          <SyncStatus
            job={analysisJob}
            onPause={() =>
              void api("stop", {}).catch((e) => setError(e.message))
            }
          />
          <Button
            variant="default"
            disabled={rebuilding || analysisBusy}
            onClick={() => void syncSessions()}
          >
            <RefreshCw size={15} className={analysisBusy ? "spinning" : ""} />
            {analysisBusy ? "Syncing sessions…" : "Sync sessions"}
          </Button>
        </div>
      </header>
      {error && (
        <div role="alert" className="td-alert">
          <span>{error}</span>
          <button onClick={() => setError("")} aria-label="Dismiss error">
            <X size={14} />
          </button>
        </div>
      )}
      <SegmentedControl
        className="atlas-session-status"
        fullWidth
        value={status}
        onChange={setStatus}
        aria-label="Session status filter"
        data={[
          ["all", "Sessions"],
          ["running", "Running"],
          ["unread", "Unread"],
        ].map(([key, label]) => ({
          value: key,
          label: (
            <div className="atlas-stat-label">
              <span className="atlas-stat-symbol">
                {key === "all" ? (
                  <Network size={17} />
                ) : (
                  <i
                    style={{
                      background:
                        key === "unread"
                          ? "#3b82c4"
                          : statusColors[
                              displaySessionStatus(key as SessionStatus)
                            ],
                    }}
                  />
                )}
              </span>
              <span>
                <Text component="span" fw={600} size="xl" display="block">
                  {data ? statusCounts[key as keyof typeof statusCounts] : "—"}
                </Text>
                <Text component="span" size="xs" c="dimmed">
                  {label}
                </Text>
              </span>
            </div>
          ),
        }))}
      />
      <SyncWarnings
        job={analysisJob}
        namingPending={namingPending}
        onRetry={() =>
          void api("analysis/name", {}).catch((e) => setError(e.message))
        }
      />
      {analysisJob?.phase === "error" && (
        <div className="td-alert" role="alert">
          {analysisJob.contentReady
            ? "Conversation text is ready; work-stream update failed: "
            : "Sync could not finish: "}
          {analysisJob.error}
        </div>
      )}
      <section className="td-stream-section">
        <div className="td-stream-heading">
          <div>
            <h2>Your work streams</h2>
            <p>
              Most active today{" "}
              <span>
                · {visible.length} of {sessions.length} sessions in view
              </span>
            </p>
          </div>
          {archived.length || showHidden ? (
            <Button
              variant="default"
              aria-expanded={showHidden}
              onClick={() => setShowHidden(!showHidden)}
            >
              Archived ({archived.length})
            </Button>
          ) : null}
        </div>
        <div className="atlas-today-filters">
          <TextInput
            aria-label="Find a session"
            placeholder="Find a session…"
            leftSection={<Search size={16} />}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            className="atlas-session-search"
          />
          <Select
            aria-label="Session provider"
            value={provider}
            onChange={(value) => setProvider(value || "all")}
            data={[
              { value: "all", label: "All sources" },
              { value: "claude", label: "Claude" },
              { value: "codex", label: "Codex" },
            ]}
            w={180}
          />
          {(query || provider !== "all" || status !== "all") && (
            <button
              className="text-button"
              onClick={() => {
                setQuery("");
                setProvider("all");
                setStatus("all");
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        {showHidden && (
          <section
            className="td-hidden-panel"
            aria-label="Archived sessions and streams"
          >
            <p>
              Archived sessions and work streams active today. Restore them to
              bring them back into view.
            </p>
            {archived.map((h) => (
              <div key={h.kind + ":" + h.id}>
                <span title={h.label}>
                  <small>
                    {h.kind === "stream" ? "Work stream" : "Session or family"}
                  </small>
                  {h.label}
                </span>
                <Button
                  variant="default"
                  onClick={() =>
                    void setVisibility(h.kind, h.id, false, h.label)
                  }
                >
                  Restore
                </Button>
              </div>
            ))}
            {!archived.length && <p>Nothing archived today.</p>}
          </section>
        )}
        {data && (
          <TodayBoards
            data={data}
            selected={selected}
            sessions={visible}
            onSelect={selectSession}
            onSetDetached={(id, detached) => void setDetached(id, detached)}
            onHideSession={(id) =>
              void setVisibility("session", id, true, byId.get(id)?.title || id)
            }
            onHideStream={(id) =>
              void setVisibility(
                "stream",
                String(id),
                true,
                data.workstreams?.find((s) => s.id === id)?.name || String(id),
              )
            }
            onOpenStream={(id) =>
              onOpenStream?.(id, {
                project: "",
                start: data.start,
                end: data.end,
              })
            }
          />
        )}
        {loading && !data && (
          <p className="td-basis" role="status">
            Reading local sessions…
          </p>
        )}
        <div className="td-stream-updated">
          {data
            ? "Activity updates every 3s" +
              (data.streamsUpdatedAt
                ? " · Work streams updated " + age(data.streamsUpdatedAt)
                : " · Streams not built yet") +
              (data.unclassifiedSessions
                ? ` · ${data.unclassifiedSessions} awaiting assignment`
                : "")
            : "Connecting…"}
          {autoSync &&
            (autoSync.paused
              ? " · Automatic sync paused; Sync sessions resumes it"
              : " · Automatic sync checks every 30s")}
        </div>
        {data?.warnings.map((w) => (
          <p className="td-subtle-warning" key={w}>
            {w}
          </p>
        ))}
      </section>
      <section className="td-board" aria-labelledby="shared-tasks-title">
        <div className="td-board-header">
          <div>
            <h2 id="shared-tasks-title">
              <button
                className="td-board-toggle"
                onClick={() => setBoard(!board)}
                aria-expanded={board}
                aria-controls="shared-tasks-content"
              >
                <ChevronDown
                  size={17}
                  style={{ rotate: board ? "0deg" : "-90deg" }}
                />
                Shared tasks
              </button>
            </h2>
            <p>One board for you and your assistants.</p>
          </div>
          <Button variant="filled" onClick={() => openTask()}>
            <Plus size={16} /> Add task
          </Button>
        </div>
        <div id="shared-tasks-content" hidden={!board}>
          <Tabs
            value={String(activeBoard)}
            onChange={(value) =>
              setBoardStream(
                value === "all" || value === null ? "all" : Number(value),
              )
            }
          >
            <Tabs.List className="atlas-board-tabs" aria-label="Task boards">
              {[{ id: "all" as const, name: "All" }, ...boardStreams].map(
                (stream) => (
                  <Tabs.Tab
                    key={stream.id}
                    value={String(stream.id)}
                    rightSection={
                      <CountBadge size="sm" variant="light" color="gray">
                        {
                          (data?.tasks || []).filter(
                            (task) =>
                              task.status !== "done" &&
                              (stream.id === "all" ||
                                task.streamId === stream.id),
                          ).length
                        }
                      </CountBadge>
                    }
                  >
                    {stream.name}
                  </Tabs.Tab>
                ),
              )}
            </Tabs.List>
            <Tabs.Panel value={String(activeBoard)}>
              <div className="td-kanban">
                {columns.map(([key, label]) => (
                  <div
                    className={"td-column " + key}
                    key={key}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const task = data?.tasks.find(
                        (t) => t.id === e.dataTransfer.getData("text/plain"),
                      );
                      if (task) void moveTask(task, key);
                    }}
                  >
                    <div className="td-column-head">
                      <i />
                      <strong>{label}</strong>
                      <span>
                        {boardTasks.filter((t) => t.status === key).length}
                      </span>
                      <button
                        aria-label={"Add task to " + label}
                        onClick={() => openTask(null, undefined, key)}
                      >
                        <Plus size={16} />
                      </button>
                    </div>
                    <div
                      className="td-task-list"
                      role="region"
                      aria-label={`${label} tasks`}
                      tabIndex={
                        boardTasks.some((t) => t.status === key) ? 0 : undefined
                      }
                    >
                      {boardTasks
                        .filter((t) => t.status === key)
                        .sort(compareTasks)
                        .map((t) => (
                          <button
                            key={t.id}
                            className="td-task"
                            draggable={!t.suspended}
                            onDragStart={(e) =>
                              e.dataTransfer.setData("text/plain", t.id)
                            }
                            onClick={() => openTask(t)}
                          >
                            <span className="td-task-title">
                              {key === "done" && (
                                <Check size={15} aria-hidden="true" />
                              )}
                              <span className="td-task-title-text">
                                {t.title}
                              </span>
                              {!!t.attachments?.length && (
                                <span
                                  className="td-task-attachment"
                                  role="img"
                                  aria-label={`${t.attachments.length} attached ${t.attachments.length === 1 ? "image" : "images"}`}
                                  title="Attached images"
                                >
                                  <Paperclip size={14} aria-hidden="true" />
                                </span>
                              )}
                            </span>
                            {t.notes && (
                              <span className="td-task-notes">{t.notes}</span>
                            )}
                            <span className="td-task-meta">
                              <TaskOrigin origin={t.createdBy} />
                              {t.suspended && (
                                <span className="td-task-suspended">
                                  <Pause size={12} aria-hidden="true" />{" "}
                                  Suspended
                                </span>
                              )}
                              {activeBoard === "all" && t.streamId !== null && (
                                <span>
                                  {taskStreams.find((s) => s.id === t.streamId)
                                    ?.name || "Work stream"}
                                </span>
                              )}
                              {t.sessions.length > 0 && (
                                <span>
                                  {t.sessions.length} linked{" "}
                                  {t.sessions.length === 1
                                    ? "session"
                                    : "sessions"}
                                </span>
                              )}
                            </span>
                          </button>
                        ))}
                      {!boardTasks.some((t) => t.status === key) && (
                        <p className="td-empty-column">
                          {key === "done"
                            ? "No completed tasks"
                            : key === "doing"
                              ? "Nothing in progress"
                              : "No tasks to do"}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Tabs.Panel>
          </Tabs>
        </div>
      </section>
      <p className="td-bottom-note">
        Saved locally · {Intl.DateTimeFormat().resolvedOptions().timeZone}
      </p>
      {selectedSession && (
        <Drawer
          opened
          onClose={() => setSelected(null)}
          trapFocus={!taskOpened && renameSession !== selectedSession.id}
          closeOnClickOutside={
            !taskOpened && renameSession !== selectedSession.id
          }
          closeOnEscape={!taskOpened && renameSession !== selectedSession.id}
          title={
            <span className="atlas-drawer-label">
              <span
                className={"td-provider " + selectedSession.provider}
                aria-hidden="true"
              >
                {selectedSession.provider === "claude" ? "✳" : "⌘"}
              </span>
              {selectedSession.provider === "claude" ? "Claude" : "Codex"}
            </span>
          }
          closeButtonProps={{ "aria-label": "Close session details" }}
          padding={24}
          classNames={{ body: "td-detail" }}
        >
          <div key={selectedSession.id}>
            <h2>{selectedSession.title}</h2>
            {renameSession === selectedSession.id && (
              <SessionRename
                key={selectedSession.id}
                session={selectedSession}
                onClose={() => setRenameSession(null)}
                onSaved={(title) => {
                  setRenameSession(null);
                  setData((current) =>
                    current
                      ? {
                          ...current,
                          sessions: current.sessions.map((s) =>
                            s.id === selectedSession.id ? { ...s, title } : s,
                          ),
                        }
                      : current,
                  );
                  notify("Session renamed");
                  void refresh(true);
                }}
              />
            )}
            <Group gap="xs">
              <Badge status={selectedSession.status} />
              <Text size="xs" c="dimmed">
                {selectedSession.project}
              </Text>
              <Text size="xs" c="dimmed">
                {age(selectedSession.statusAt || selectedSession.updated)}
              </Text>
            </Group>
            {selectedSession.status !== "needs_input" &&
              /waiting|background/i.test(selectedSession.basis || "") && (
                <Text size="xs" c="dimmed" mt="xs">
                  {selectedSession.basis}
                </Text>
              )}
            <Group gap="xs" wrap="nowrap" mt="md" mb="lg">
              {(() => {
                const link = sessionOpenLink(selectedSession, byId);
                return (
                  <Button
                    variant={link.href ? "filled" : "default"}
                    component="a"
                    href={link.href || undefined}
                    aria-disabled={!link.href}
                    onClick={(e) => {
                      if (!link.href) e.preventDefault();
                    }}
                    rightSection={<ArrowUpRight size={13} />}
                    title={
                      link.parent
                        ? "Open the parent conversation in Claude"
                        : undefined
                    }
                  >
                    {link.label}
                  </Button>
                );
              })()}
              <Button
                variant="default"
                leftSection={<Sparkles size={14} />}
                disabled={selectedSession.inclusion === "archive"}
                aria-expanded={briefSession === selectedSession.id}
                aria-controls={`session-tldr-${selectedSession.id}`}
                onClick={() =>
                  setBriefSession((current) =>
                    current === selectedSession.id ? null : selectedSession.id,
                  )
                }
              >
                TLDR
              </Button>
              <Menu position="bottom-end" withinPortal zIndex={215}>
                <Menu.Target>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    aria-label="More session actions"
                  >
                    <Ellipsis size={18} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item
                    leftSection={<Pencil size={14} />}
                    disabled={selectedSession.inclusion === "archive"}
                    onClick={() => setRenameSession(selectedSession.id)}
                  >
                    Rename session
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<Archive size={14} />}
                    onClick={() =>
                      void setVisibility(
                        "session",
                        selectedSession.id,
                        true,
                        selectedSession.title,
                      )
                    }
                  >
                    Archive{" "}
                    {edgeList.some((e) => e.parent === selectedSession.id)
                      ? "family"
                      : "session"}
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<Copy size={14} />}
                    onClick={() => void copy(selectedSession.id)}
                  >
                    Copy session ID
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </Group>
            {briefSession === selectedSession.id && (
              <SessionBrief session={selectedSession} />
            )}
            <section className="td-session-section" aria-label="Linked tasks">
              <Group justify="space-between" mb="xs">
                <Text size="sm" fw={600}>
                  Tasks
                  {openSelectedTasks.length
                    ? ` (${openSelectedTasks.length})`
                    : ""}
                </Text>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  leftSection={<Plus size={13} />}
                  onClick={() => openTask(null, selectedSession.id)}
                >
                  Add task
                </Button>
              </Group>
              <Stack gap={6}>
                {openSelectedTasks.slice(0, 5).map((t) => (
                  <UnstyledButton
                    className="td-session-link"
                    key={t.id}
                    onClick={() => openTask(t)}
                  >
                    <Text size="sm" lineClamp={2}>
                      {t.title}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {t.suspended
                        ? "Suspended"
                        : t.status === "doing"
                          ? "In progress"
                          : "To do"}
                    </Text>
                  </UnstyledButton>
                ))}
              </Stack>
              {openSelectedTasks.length > 5 && (
                <details className="td-session-disclosure">
                  <summary>
                    <ChevronDown size={16} aria-hidden="true" />
                    {openSelectedTasks.length - 5} more open tasks
                  </summary>
                  <Stack gap={0}>
                    {openSelectedTasks.slice(5).map((t) => (
                      <UnstyledButton
                        className="td-session-link"
                        key={t.id}
                        onClick={() => openTask(t)}
                      >
                        <Text size="sm" lineClamp={2}>
                          {t.title}
                        </Text>
                      </UnstyledButton>
                    ))}
                  </Stack>
                </details>
              )}
              {!!completedSelectedTasks.length && (
                <details className="td-session-disclosure">
                  <summary>
                    <ChevronDown size={16} aria-hidden="true" />
                    Completed tasks ({completedSelectedTasks.length})
                  </summary>
                  <Stack gap={0} className="td-session-link-list">
                    {completedSelectedTasks.map((t) => (
                      <UnstyledButton
                        className="td-session-link"
                        key={t.id}
                        onClick={() => openTask(t)}
                      >
                        <Text size="sm" lineClamp={2}>
                          {t.title}
                        </Text>
                      </UnstyledButton>
                    ))}
                  </Stack>
                </details>
              )}
            </section>
            {selectedSession.familyLink && (
              <Button
                variant="default"
                leftSection={
                  selectedSession.familyDetached ? (
                    <Link2 size={15} />
                  ) : (
                    <Unlink2 size={15} />
                  )
                }
                onClick={() =>
                  void setDetached(
                    selectedSession.id,
                    !selectedSession.familyDetached,
                  )
                }
              >
                {selectedSession.familyDetached
                  ? "Reattach to related conversation"
                  : "Detach and show separately"}
              </Button>
            )}
            {selectedDisplayParent ||
            families.get(selectedSession.id)?.length ? (
              <details className="td-session-section td-session-disclosure">
                <summary>
                  <ChevronDown size={16} aria-hidden="true" />
                  Linked sessions (
                  {(families.get(selectedSession.id)?.length || 0) +
                    (selectedDisplayParent ? 1 : 0)}
                  )
                </summary>
                <Stack gap={0} className="td-session-link-list">
                  {selectedDisplayParent && (
                    <UnstyledButton
                      className="td-session-link"
                      onClick={() => selectSession(selectedDisplayParent)}
                    >
                      <Text size="xs" c="dimmed">
                        {selectedSession.parent === selectedDisplayParent
                          ? "Parent session"
                          : "Grouped with"}
                      </Text>
                      <Text size="sm">
                        {byId.get(selectedDisplayParent)?.title ||
                          selectedDisplayParent}
                      </Text>
                    </UnstyledButton>
                  )}
                  {families.get(selectedSession.id)?.map((child) => (
                    <UnstyledButton
                      className="td-session-link"
                      key={child.id}
                      onClick={() => selectSession(child.id)}
                    >
                      <Text size="sm" lineClamp={2}>
                        {child.title}
                      </Text>
                    </UnstyledButton>
                  ))}
                </Stack>
              </details>
            ) : null}
            {!!historyPeers.length && (
              <details className="td-session-section td-session-disclosure">
                <summary>
                  <ChevronDown size={16} aria-hidden="true" />
                  Related chats ({historyPeers.length})
                </summary>
                <Text size="xs" c="dimmed" mb="xs">
                  Shared or forked history is grouped on Today. Each chat keeps
                  its own status and delegated agents; detach it to show it
                  separately.
                </Text>
                <Stack gap={0} className="td-session-link-list">
                  {historyPeers.map((peer) => (
                    <UnstyledButton
                      className="td-session-link"
                      key={peer.id}
                      onClick={() => selectSession(peer.id)}
                    >
                      <Text size="sm">{peer.title}</Text>
                    </UnstyledButton>
                  ))}
                </Stack>
              </details>
            )}
            <details className="td-session-section td-session-disclosure">
              <summary>
                <ChevronDown size={16} aria-hidden="true" />
                Session details
              </summary>
              <Stack gap="md" mt="sm">
                <Select
                  label="Work stream"
                  aria-label="Move session to work stream"
                  searchable
                  placeholder="Not assigned yet"
                  value={
                    selectedSession.boardStreamId == null
                      ? null
                      : String(selectedSession.boardStreamId)
                  }
                  data={(data?.workstreams || []).map((stream) => ({
                    value: String(stream.id),
                    label: stream.name,
                  }))}
                  onChange={async (value) => {
                    if (!value) return;
                    try {
                      await api("streams/assign", {
                        session: selectedSession.id,
                        streamId: Number(value),
                      });
                      await refresh(true);
                      notify("Work stream updated.");
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                />
                {selectedSession.lastRequest && (
                  <div>
                    <Text size="xs" fw={600} c="dimmed" mb={4}>
                      Latest user request
                    </Text>
                    <Text size="sm">{selectedSession.lastRequest}</Text>
                  </div>
                )}
                {selectedSession.status !== "needs_input" &&
                  selectedSession.basis && (
                    <Text size="xs" c="dimmed">
                      {selectedSession.basis}
                    </Text>
                  )}
                {selectedSession.originEvidence && (
                  <Text size="xs" c="dimmed">
                    {selectedSession.originEvidence}
                  </Text>
                )}
                {selectedSession.relationship === "shared_history" && (
                  <Text size="xs" c="dimmed">
                    Shares message history with this conversation family; no
                    parent relationship was recorded.
                  </Text>
                )}
                {selectedSession.originalTitle &&
                  selectedSession.originalTitle !== selectedSession.title && (
                    <div>
                      <Text size="xs" fw={600} c="dimmed" mb={4}>
                        Original title
                      </Text>
                      <Text size="sm">{selectedSession.originalTitle}</Text>
                    </div>
                  )}
                <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
                  {selectedSession.id}
                </Text>
                {selectedSession.sampled && (
                  <Text size="xs" c="dimmed">
                    Large log: middle context may be missing from sampled
                    evidence.
                  </Text>
                )}
              </Stack>
            </details>
          </div>
        </Drawer>
      )}
      <Modal
        opened={taskOpened}
        size={680}
        scrollAreaComponent={ScrollArea.Autosize}
        onClose={() => {
          if (!imageOverlayOpen && !saving) setTaskOpened(false);
        }}
        trapFocus={!imageOverlayOpen}
        closeOnEscape={!imageOverlayOpen && !saving}
        closeOnClickOutside={!imageOverlayOpen && !saving}
        zIndex={220}
        title={
          deleteTarget
            ? "Delete task?"
            : taskMode === "view" && viewedTask
              ? viewedTask.title
              : edit
                ? "Edit task"
                : "New task"
        }
        closeButtonProps={{ "aria-label": "Close task", disabled: saving }}
        classNames={{ content: "atlas-task-modal" }}
        styles={{
          header: { alignItems: "flex-start", paddingBottom: 16 },
          title: {
            fontSize: 18,
            fontWeight: taskMode === "view" && !deleteTarget ? 500 : 600,
            lineHeight: 1.5,
          },
          close: { marginTop: 2 },
        }}
      >
        <>
          {deleteTarget ? (
            <Stack gap="md">
              <Text fw={600}>{deleteTarget.title}</Text>
              <Text>
                This permanently removes the task from the shared board. Linked
                conversations are kept.
              </Text>
              {taskError && (
                <Text c="red" role="alert">
                  {taskError}
                </Text>
              )}
              <Group justify="flex-end" gap="lg" mt="sm">
                <Button
                  variant="default"
                  disabled={saving}
                  onClick={() => {
                    setDeleteTarget(null);
                    setTaskError("");
                  }}
                >
                  Keep task
                </Button>
                <Button
                  color="red"
                  loading={saving}
                  onClick={() => void deleteTask()}
                >
                  Delete task
                </Button>
              </Group>
            </Stack>
          ) : taskMode === "view" && viewedTask ? (
            <>
              {(viewedTask.streamId !== null || viewedTask.project) && (
                <div className="td-task-context">
                  <Network size={14} aria-hidden="true" />
                  <span>
                    {[
                      taskStreams.find((s) => s.id === viewedTask.streamId)
                        ?.name ||
                        (viewedTask.streamId !== null
                          ? "Previous work stream"
                          : ""),
                      viewedTask.project,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
              )}
              <Group
                justify="space-between"
                gap="sm"
                className="td-task-toolbar"
              >
                <Group gap="sm">
                  <Select
                    aria-label="Task status"
                    comboboxProps={{ zIndex: 240 }}
                    size="sm"
                    w={140}
                    leftSection={
                      <span
                        className={`td-task-status-dot ${viewedTask.status}`}
                      />
                    }
                    value={viewedTask.status}
                    data={columns.map(([value, label]) => ({ value, label }))}
                    allowDeselect={false}
                    disabled={saving}
                    onChange={(value) => {
                      if (value)
                        void moveTask(viewedTask, value as Task["status"]);
                    }}
                  />
                  {viewedTask.suspended && (
                    <CountBadge
                      color="gray"
                      variant="light"
                      leftSection={<Pause size={11} />}
                    >
                      Suspended
                    </CountBadge>
                  )}
                </Group>
                <Group gap="xs">
                  <Button
                    variant="default"
                    disabled={saving}
                    leftSection={<Pencil size={14} />}
                    onClick={() =>
                      openTask(viewedTask, undefined, "todo", true)
                    }
                  >
                    Edit task
                  </Button>
                  <Menu position="bottom-end" withinPortal zIndex={240}>
                    <Menu.Target>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        aria-label="More task actions"
                        size={34}
                        disabled={saving}
                      >
                        <Ellipsis size={18} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        leftSection={
                          viewedTask.suspended ? (
                            <Play size={14} />
                          ) : (
                            <Pause size={14} />
                          )
                        }
                        onClick={() => void toggleTaskSuspension(viewedTask)}
                      >
                        {viewedTask.suspended ? "Resume task" : "Suspend task"}
                      </Menu.Item>
                      <Menu.Divider />
                      <Menu.Item
                        color="red"
                        leftSection={<Trash2 size={14} />}
                        onClick={() => {
                          setDeleteTarget(viewedTask);
                          setTaskError("");
                        }}
                      >
                        Delete task
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </Group>
              </Group>
              {viewedTask.suspended && (
                <Text size="xs" c="dimmed" mb="md">
                  Agents skip this task until you resume it.
                </Text>
              )}
              <div className="td-task-detail-notes">
                {viewedTask.notes ? (
                  <Markdown>{viewedTask.notes}</Markdown>
                ) : (
                  <p className="td-task-no-notes">No notes yet.</p>
                )}
              </div>
              {(viewedTask.createdSession ||
                viewedTask.sessions.length > 0) && (
                <section
                  className="td-task-detail-links"
                  aria-label="Task sessions"
                >
                  <h3>Sessions</h3>
                  {[
                    ...new Set([
                      ...(viewedTask.createdSession
                        ? [viewedTask.createdSession]
                        : []),
                      ...viewedTask.sessions,
                    ]),
                  ].map((id) => {
                    const session = taskSession(id);
                    return (
                      <UnstyledButton
                        key={id}
                        className="td-task-session-link"
                        onClick={() => void openTaskSession(id)}
                      >
                        <span>
                          {session.title}
                          <small>
                            {id === viewedTask.createdSession
                              ? "Created here · "
                              : ""}
                            {session.provider === "claude" ? "Claude" : "Codex"}
                            {session.project ? " · " + session.project : ""}
                          </small>
                        </span>
                        <PanelRight size={16} aria-hidden="true" />
                      </UnstyledButton>
                    );
                  })}
                </section>
              )}
              <TaskImages
                images={viewedTask.attachments || []}
                taskId={viewedTask.id}
                onAnnotate={saveAnnotatedImage}
                onViewerChange={setImageOverlayOpen}
              />
              {taskError && (
                <Text c="red" size="sm" role="alert" mt="md">
                  {taskError}
                </Text>
              )}
              <div className="td-task-view-footer td-task-provenance">
                <TaskOrigin origin={viewedTask.createdBy} detailed />
                <Text size="xs" c="dimmed">
                  Updated {age(viewedTask.updated)}
                </Text>
              </div>
            </>
          ) : (
            <form
              onSubmit={saveTask}
              onPaste={(event) => {
                const items = Array.from(event.clipboardData.items).filter(
                  (item) => item.kind === "file",
                );
                if (items.length) {
                  event.preventDefault();
                  void addTaskImages(
                    items
                      .map((item) => item.getAsFile())
                      .filter((file): file is File => !!file),
                  );
                }
              }}
            >
              <Stack gap="md">
                <TextInput
                  label="Task"
                  required
                  data-autofocus
                  autoFocus
                  maxLength={300}
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.currentTarget.value)}
                  placeholder="What needs to happen next?"
                />
                <div className="td-form-row">
                  <Select
                    label="Status"
                    value={taskStatus}
                    onChange={(value) => setTaskStatus(value as Task["status"])}
                    data={columns.map(([value, label]) => ({ value, label }))}
                  />
                  <TextInput
                    label="Project"
                    value={taskProject}
                    maxLength={200}
                    onChange={(e) => setTaskProject(e.currentTarget.value)}
                    placeholder="Optional project"
                  />
                </div>
                <Select
                  label="Work stream"
                  aria-label="Task work stream"
                  value={taskStream === "" ? "" : String(taskStream)}
                  onChange={(value) =>
                    setTaskStream(value ? Number(value) : "")
                  }
                  data={[
                    { value: "", label: "No work stream · All board only" },
                    ...taskStreams.map((stream) => ({
                      value: String(stream.id),
                      label: stream.name,
                    })),
                    ...(taskStream !== "" &&
                    !taskStreams.some((stream) => stream.id === taskStream)
                      ? [
                          {
                            value: String(taskStream),
                            label: "Previous work stream",
                          },
                        ]
                      : []),
                  ]}
                  searchable
                />
                <Textarea
                  label="Notes"
                  minRows={3}
                  maxRows={8}
                  autosize
                  maxLength={4000}
                  value={taskNotes}
                  onChange={(e) => setTaskNotes(e.currentTarget.value)}
                  placeholder="Context for whoever picks this up…"
                />
                <TaskImages
                  images={taskImages}
                  taskId={edit?.id}
                  onChange={setTaskImages}
                  onFiles={(files) => void addTaskImages(files)}
                  loading={imagesLoading}
                  onViewerChange={setImageOverlayOpen}
                />
                <SessionPicker
                  sessions={allSessions}
                  value={taskSessions}
                  onChange={setTaskSessions}
                />
              </Stack>
              {taskError && (
                <div className="alert error" role="alert">
                  {taskError}
                </div>
              )}
              {edit && (
                <p className="td-basis">
                  Revision {edit.revision}. If another session edits this task,
                  reopen it to reconcile their changes.
                </p>
              )}
              <div className="td-dialog-footer">
                <Button
                  type="button"
                  variant="default"
                  onClick={() => setTaskOpened(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="filled"
                  disabled={saving || imagesLoading}
                >
                  {saving ? "Saving…" : "Save task"}
                </Button>
              </div>
            </form>
          )}
        </>
      </Modal>
      <Modal
        opened={helpOpened}
        onClose={() => setHelpOpened(false)}
        title="How Today works"
        closeButtonProps={{ "aria-label": "Close help" }}
      >
        <div className="td-help" tabIndex={-1} data-autofocus>
          <section>
            <h3>Work streams</h3>
            <p>
              Each work stream shows one name, scope and set of conversations.
              Today shows streams with activity today. Explore uses the same
              saved clusters, names and colours.
            </p>
          </section>
          <section>
            <h3>Related chats</h3>
            <p>
              Forks and agent chats are grouped under their parent conversation.
              Expand a card to see them, or detach a chat to show it separately.
              Archive hides a chat or stream from Today; you can restore it from
              Archived.
            </p>
          </section>
          <section>
            <h3>Shared tasks</h3>
            <p>
              Tasks record what needs doing. You and connected agents share the
              same board, and a task can belong to a work stream. Move it from
              To do to In progress to Done as the work changes. An agent
              finishing a reply does not automatically complete a task.
            </p>
          </section>
          <p className="td-help-note">
            Today updates automatically. Green means an agent is running; blue
            marks a reply you haven’t opened in Atlas.
          </p>
          <Button
            variant="default"
            size="sm"
            leftSection={<Network size={14} />}
            rightSection={<ArrowUpRight size={14} />}
            onClick={() => {
              setHelpOpened(false);
              onAgentSetup();
            }}
          >
            Agent setup in MCP
          </Button>
        </div>
      </Modal>
    </div>
  );
}
