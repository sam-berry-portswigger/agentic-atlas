import { ActionIcon, SegmentedControl, UnstyledButton } from "@mantine/core";
import { compareStreamActivity } from "../shared/today-focus.js";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowUpRight,
  ChevronDown,
  Network,
  Link2,
  Unlink2,
} from "lucide-react";
import {
  CARD,
  cardBounds,
  familyRoots,
  familyOutline,
  settleToday,
  routeTodayEdges,
} from "../shared/today-layout.js";
import type { Session, Snapshot } from "./TodayView";
import "./family.css";
import {
  displaySessionStatus,
  statusLabels as statusNames,
} from "../shared/session-status-display.js";
type Props = {
  data: Snapshot;
  selected: string | null;
  sessions: Session[];
  onSelect: (id: string) => void;
  onHideSession: (id: string) => void;
  onHideStream: (id: number) => void;
  onOpenStream?: (id: number) => void;
  onSetDetached: (id: string, detached: boolean) => void;
};
function when(value: string) {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 60000),
  );
  return minutes < 1
    ? "just now"
    : minutes < 60
      ? minutes + "m ago"
      : Math.floor(minutes / 60) + "h ago";
}
function Card({
  session: s,
  root,
  selected,
  children = 0,
  onSelect,
  onHide,
  onExpand,
  expanded = false,
  runningCount = 0,
  unreadCount = 0,
  onSetDetached,
}: {
  session: Session;
  root: boolean;
  selected: boolean;
  children?: number;
  onSelect: (id: string) => void;
  onHide: (id: string) => void;
  onExpand?: () => void;
  expanded?: boolean;
  runningCount?: number;
  unreadCount?: number;
  onSetDetached?: Props["onSetDetached"];
}) {
  const unread = s.unread || unreadCount > 0;
  const activity =
    s.status === "running" || runningCount > 0
      ? "running"
      : displaySessionStatus(s.status);
  const label =
    activity === displaySessionStatus(s.status)
      ? statusNames[activity]
      : `${runningCount} linked active`;
  return (
    <div
      className={
        "td-session-card " +
        (root ? "root " : "child ") +
        (selected ? "selected " : "") +
        activity +
        (activity === "running" || activity === "error" ? "" : " inactive")
      }
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${root ? "Root" : "Child"} session: ${s.title}`}
      onClick={() => onSelect(s.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(s.id);
        }
      }}
    >
      <div className="td-card-heading">
        <span className={"td-provider " + s.provider}>
          {s.provider === "claude" ? "✳" : "⌘"}
          <span>{s.provider === "claude" ? "Claude" : "Codex"}</span>
        </span>
        <span className={"td-badge " + activity}>{label}</span>
        {s.familyLink && onSetDetached && (
          <ActionIcon
            variant="subtle"
            aria-label={
              (s.familyDetached ? "Reattach chat: " : "Detach chat: ") + s.title
            }
            title={
              s.familyDetached
                ? "Group this chat with its related conversation"
                : "Show this chat separately"
            }
            onClick={(e) => {
              e.stopPropagation();
              onSetDetached(s.id, !s.familyDetached);
            }}
          >
            {s.familyDetached ? <Link2 size={14} /> : <Unlink2 size={14} />}
          </ActionIcon>
        )}
        <button
          className="td-archive-session"
          aria-label={
            "Archive " + (children ? "family: " : "session: ") + s.title
          }
          title={children ? "Archive this family" : "Archive this session"}
          onClick={(e) => {
            e.stopPropagation();
            onHide(s.id);
          }}
        >
          <Archive size={14} />
        </button>
      </div>
      <div className="td-card-role">
        {root
          ? s.familyDetached
            ? "DETACHED CHAT"
            : children > 0 && s.historyFamily
              ? "CONVERSATION FAMILY"
              : children > 0
                ? "PARENT SESSION"
                : s.historyFamily
                  ? "SHARED-HISTORY CHAT"
                  : "SESSION"
          : s.relationship === "shared_history"
            ? "SHARED HISTORY"
            : s.originEvidence
              ? "DELEGATED FROM CLAUDE"
              : "CHILD SESSION"}
      </div>
      <div className="td-card-title">{s.title}</div>
      <div className="td-card-context">
        <div>{s.project}</div>
        {s.sameTitle && s.startedAt && (
          <div title={s.id}>
            Separate chat · started{" "}
            {new Date(s.startedAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </div>
        )}
      </div>
      <div className="td-card-actions">
        {children > 0 && onExpand && (
          <button
            className="td-family-disclosure"
            aria-expanded={expanded}
            onClick={(e) => {
              e.stopPropagation();
              onExpand();
            }}
          >
            <Network size={12} />
            {expanded ? "Collapse" : "Show"} {children} linked sessions
            <ChevronDown
              size={12}
              style={{ rotate: expanded ? "180deg" : "0deg" }}
            />
          </button>
        )}
      </div>
      <div className="td-card-footer">
        <span className="td-card-recency">
          <span
            className={
              "td-activity-dot " +
              (activity !== "running" && unread ? "unread" : activity)
            }
            aria-label={
              activity === "running"
                ? "Active session"
                : unread
                  ? "Unread response"
                  : "Inactive session"
            }
          />
          <span>{when(s.updated)}</span>
        </span>
        <span>
          {s.userTurns
            ? `${s.userTurns} ${s.userTurns === 1 ? "turn" : "turns"}`
            : s.messageCount
              ? `${s.messageCount} ${s.messageCount === 1 ? "message" : "messages"}`
              : "New session"}
        </span>
      </div>
    </div>
  );
}
type FamilyProps = {
  root: Session;
  selected: string | null;
  sessions: Session[];
  edges: Snapshot["edges"];
  onSelect: Props["onSelect"];
  onHide: (id: string) => void;
  onSetDetached: Props["onSetDetached"];
};
function FamilyTree({
  root,
  sessions,
  edges,
  onSelect,
  onHide,
  selected,
  onSetDetached,
}: FamilyProps) {
  const scroll = useRef<HTMLDivElement>(null),
    key = JSON.stringify([sessions.map((s) => s.id), edges]);
  const layout = useMemo(
    () =>
      settleToday(sessions, edges, []) as {
        id: string;
        x: number;
        y: number;
        pinned: boolean;
      }[],
    [key],
  );
  const positions = new Map(layout.map((p) => [p.id, p])),
    forest = familyRoots(sessions, edges),
    bounds = layout.map((p) => cardBounds(p, p.id === root.id)),
    left = Math.min(...bounds.map((b) => b.left)) - 35,
    top = Math.min(...bounds.map((b) => b.top)) - 35,
    width = Math.max(...bounds.map((b) => b.right)) - left + 35,
    height = Math.max(...bounds.map((b) => b.bottom)) - top + 35,
    scale = 0.88;
  useEffect(() => {
    const p = positions.get(root.id),
      el = scroll.current;
    if (p && el) {
      el.scrollLeft = (p.x - left) * scale - el.clientWidth / 2;
      el.scrollTop = (p.y - top) * scale - el.clientHeight / 2;
    }
  }, [key]);
  return (
    <>
      <div
        className="stream-family-scroll"
        ref={scroll}
        style={{ height: Math.min(510, Math.max(250, height * scale)) }}
      >
        <svg
          width={width * scale}
          height={height * scale}
          viewBox={`${left} ${top} ${width} ${height}`}
          aria-label={"Linked session tree for " + root.title}
        >
          {routeTodayEdges(sessions, edges, layout).map((edge: any) => (
            <path
              key={edge.parent + edge.child}
              d={edge.path}
              className="td-card-edge"
              strokeDasharray={
                edges.some(
                  (e) =>
                    e.parent === edge.parent &&
                    e.child === edge.child &&
                    ["shared_history", "forked"].includes(e.kind),
                )
                  ? "5 4"
                  : undefined
              }
            />
          ))}
          {sessions.map((s) => {
            const p = positions.get(s.id);
            if (!p) return null;
            const isRoot = s.id === root.id,
              w = isRoot ? CARD.rootWidth : CARD.width,
              h = isRoot ? CARD.rootHeight : CARD.height;
            return (
              <foreignObject
                key={s.id}
                x={p.x - w / 2}
                y={p.y - h / 2}
                width={w}
                height={h}
              >
                <Card
                  session={s}
                  selected={selected === s.id}
                  onHide={onHide}
                  runningCount={
                    isRoot
                      ? sessions.filter(
                          (child) =>
                            child.id !== s.id && child.status === "running",
                        ).length
                      : 0
                  }
                  unreadCount={
                    sessions.filter(
                      (child) =>
                        child.id !== s.id &&
                        forest.root(child.id) === s.id &&
                        child.unread,
                    ).length
                  }
                  root={isRoot}
                  children={edges.filter((e) => e.parent === s.id).length}
                  onSelect={onSelect}
                  onSetDetached={onSetDetached}
                />
              </foreignObject>
            );
          })}
        </svg>
      </div>
      <small className="stream-family-hint">
        Scroll to explore linked chats and delegated agents. Detach a related
        chat to give it a separate card.
      </small>
    </>
  );
}
function Family(props: FamilyProps) {
  const { root, sessions, edges, selected, onSelect, onHide, onSetDetached } =
    props;
  const [view, setView] = useState("sessions");
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return (
    <section className="stream-family">
      <div className="stream-family-heading">
        <Network size={14} />
        <div className="stream-family-label">
          <strong>{root.title}</strong>
          <span>{sessions.length - 1} linked sessions</span>
        </div>
        <SegmentedControl
          className="family-view-switch"
          size="xs"
          value={view}
          onChange={setView}
          aria-label={"Linked session view for " + root.title}
          data={[
            { value: "sessions", label: "Sessions" },
            { value: "tree", label: "Tree" },
          ]}
        />
      </div>
      {view === "tree" ? (
        <FamilyTree {...props} />
      ) : (
        <div
          className="stream-family-list"
          role="list"
          aria-label={"Linked sessions for " + root.title}
        >
          {familyOutline(sessions, edges, root.id).map((row) => {
            const session = byId.get(row.id)!;
            return (
              <div
                key={session.id}
                role="listitem"
                className="family-session-row"
                data-selected={selected === session.id || undefined}
              >
                <UnstyledButton
                  className="family-session-open"
                  style={{
                    paddingInlineStart: 12 + Math.min(row.depth, 4) * 16,
                  }}
                  onClick={() => onSelect(session.id)}
                  title={session.originalTitle || session.title}
                  aria-pressed={selected === session.id}
                >
                  <span className="family-session-title">
                    {session.unread && (
                      <span
                        className="td-activity-dot unread family-unread"
                        aria-label="Unread response"
                      />
                    )}
                    {row.depth > 0 && <span aria-hidden="true">↳ </span>}
                    {session.title}
                  </span>
                  <small>
                    {row.parent === null
                      ? "Parent"
                      : row.kind === "shared_history"
                        ? "Shared history"
                        : row.kind === "forked"
                          ? "Forked chat"
                          : row.kind === "delegated"
                            ? "Delegated"
                            : "Child"}{" "}
                    · {session.provider === "claude" ? "Claude" : "Codex"} ·{" "}
                    {when(session.updated)}
                  </small>
                </UnstyledButton>
                <span
                  className={"td-badge " + displaySessionStatus(session.status)}
                >
                  {statusNames[displaySessionStatus(session.status)]}
                </span>
                {session.familyLink && (
                  <ActionIcon
                    className="family-session-detach"
                    variant="subtle"
                    aria-label={
                      (session.familyDetached
                        ? "Reattach chat: "
                        : "Detach chat: ") + session.title
                    }
                    title={
                      session.familyDetached
                        ? "Group this chat with its related conversation"
                        : "Show this chat separately"
                    }
                    onClick={() =>
                      onSetDetached(session.id, !session.familyDetached)
                    }
                  >
                    {session.familyDetached ? (
                      <Link2 size={15} />
                    ) : (
                      <Unlink2 size={15} />
                    )}
                  </ActionIcon>
                )}
                <ActionIcon
                  className="family-session-archive"
                  variant="subtle"
                  aria-label={"Archive session: " + session.title}
                  title="Archive this session"
                  onClick={() => onHide(session.id)}
                >
                  <Archive size={15} />
                </ActionIcon>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
export default function TodayBoards({
  data,
  selected,
  sessions,
  onSelect,
  onOpenStream,
  onHideSession,
  onHideStream,
  onSetDetached,
}: Props) {
  const [other, setOther] = useState(false),
    [expanded, setExpanded] = useState<Set<string>>(new Set()),
    forest = familyRoots(sessions, data.edges),
    metadata = new Map((data.workstreams || []).map((s) => [s.id, s]));
  const groups = new Map<
    string,
    {
      id: number | null;
      name: string;
      description: string;
      color: string;
      roots: Session[];
      background: boolean;
      activity?: { periods: number; requests: number; latest: number };
    }
  >();
  for (const root of forest.roots) {
    const streamId = root.boardStreamId ?? null,
      stream = streamId !== null ? metadata.get(streamId) : null;
    // Eligibility for Today and canonical stream membership are separate.
    // A saved named assignment must not become Other based on activity status.
    const hidden = !data.catalogueReady || !stream || stream.background;
    const key = hidden ? "other" : String(streamId);
    if (!groups.has(key))
      groups.set(key, {
        id: hidden ? null : streamId,
        name: hidden ? "Other sessions" : stream!.name,
        description: hidden
          ? "Unassigned, incidental or unverified activity. Original sessions remain available."
          : stream!.description,
        color: hidden ? "#a2ae98" : stream!.color,
        roots: [],
        activity: stream?.activity,
        background: hidden,
      });
    groups.get(key)!.roots.push(root);
  }
  const render = (group: ReturnType<typeof groups.get>) => {
    if (!group) return null;
    const ids = new Set(group.roots.map((r) => r.id)),
      familySessions = sessions.filter((s) => ids.has(forest.root(s.id))),
      trees = group.roots.filter((r) =>
        familySessions.some(
          (child) => child.id !== r.id && forest.root(child.id) === r.id,
        ),
      ),
      standalone = group.roots;
    return (
      <section
        key={group.id ?? "other"}
        className="stream-board"
        style={{ "--stream-color": group.color } as React.CSSProperties}
      >
        <header>
          <span className="stream-board-dot" />
          <div>
            <h3>{group.name}</h3>
            <p>{group.description}</p>
          </div>
          <span className="stream-board-count">
            {group.roots.length}{" "}
            {group.roots.length === 1 ? "conversation" : "conversations"} ·{" "}
            {familySessions.length}{" "}
            {familySessions.length === 1 ? "session" : "sessions"}
          </span>
          {group.id !== null && (
            <button
              className="td-archive-stream"
              aria-label={"Archive stream: " + group.name}
              title="Archive this work stream"
              onClick={() => onHideStream(group.id!)}
            >
              <Archive size={16} />
            </button>
          )}
          {group.id !== null && onOpenStream && (
            <button
              aria-label={"Open " + group.name}
              onClick={() => onOpenStream(group.id!)}
            >
              <ArrowUpRight size={15} />
            </button>
          )}
        </header>
        {standalone.length > 0 && (
          <div className="stream-card-grid">
            {standalone.map((s) => (
              <Card
                key={s.id}
                session={s}
                selected={selected === s.id}
                root
                onHide={onHideSession}
                children={
                  familySessions.filter(
                    (child) =>
                      child.id !== s.id && forest.root(child.id) === s.id,
                  ).length
                }
                runningCount={
                  familySessions.filter(
                    (child) =>
                      child.id !== s.id &&
                      forest.root(child.id) === s.id &&
                      child.status === "running",
                  ).length
                }
                unreadCount={
                  familySessions.filter(
                    (child) =>
                      child.id !== s.id &&
                      forest.root(child.id) === s.id &&
                      child.unread,
                  ).length
                }
                expanded={expanded.has(s.id)}
                onExpand={() =>
                  setExpanded((old) => {
                    const next = new Set(old);
                    next.has(s.id) ? next.delete(s.id) : next.add(s.id);
                    return next;
                  })
                }
                onSelect={onSelect}
                onSetDetached={onSetDetached}
              />
            ))}
          </div>
        )}
        {trees
          .filter((root) => expanded.has(root.id))
          .map((root) => {
            const family = sessions.filter(
                (s) => forest.root(s.id) === root.id,
              ),
              members = new Set(family.map((s) => s.id));
            return (
              <Family
                key={root.id}
                root={root}
                selected={selected}
                sessions={family}
                edges={data.edges.filter(
                  (e) => members.has(e.parent) && members.has(e.child),
                )}
                onSelect={onSelect}
                onHide={onHideSession}
                onSetDetached={onSetDetached}
              />
            );
          })}
      </section>
    );
  };
  const active = [...groups.values()]
    .filter((g) => !g.background)
    .sort(compareStreamActivity);
  return (
    <div className="today-stream-boards">
      {!data.catalogueReady && (
        <div className="td-alert">
          Rebuild work streams once to organise these boards using the shared
          catalogue. The old topic snapshot is still available in Explore.
        </div>
      )}
      {active.map(render)}
      {groups.has("other") && (
        <div className="other-sessions">
          <button
            className="other-toggle"
            aria-expanded={other}
            onClick={() => setOther(!other)}
          >
            <ChevronDown
              size={14}
              style={{ rotate: other ? "0deg" : "-90deg" }}
            />
            Other sessions{" "}
            <span>{groups.get("other")!.roots.length} roots</span>
          </button>
          {other && render(groups.get("other"))}
        </div>
      )}
      {!sessions.length && (
        <p className="td-basis">No sessions match these filters.</p>
      )}
    </div>
  );
}
