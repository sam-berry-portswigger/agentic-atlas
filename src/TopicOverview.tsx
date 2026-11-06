import SessionRename from "./SessionRename";
import { Drawer, ActionIcon, Group, Tooltip } from "@mantine/core";
import Markdown from "./Markdown.js";
import { readNDJSON } from "../shared/stream.js";
import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Network, Square, Pencil } from "lucide-react";
import { formatDate, type Excerpt } from "./api";
export type WorkItemSelection = {
  kind: "work";
  workId?: string;
  analysisVersion?: string;
  title: string;
  sourceIds: string[];
};
export type StreamSelection = {
  kind: "stream";
  streamId: number;
  scope?: { project: string; start: string; end: string };
  analysisVersion?: string;
};
export type TopicSelection =
  | WorkItemSelection
  | StreamSelection
  | { kind: "cluster"; id: string; analysisVersion?: string };
type Conversation = {
  provider: "claude" | "codex";
  session: string;
  title: string;
  project: string;
  start: string;
  end: string;
  passages: number;
  preview: string;
};
type Topic = {
  topicId?: number;
  analysisVersion: string;
  cluster: number | null;
  color: string;
  topicIds?: number[];
  title: string;
  passages: number;
  start: string;
  end: string;
  projects: string[];
  conversations: Conversation[];
};
type Summary = {
  summary: string;
  sources: Excerpt[];
};
export default function TopicOverview({
  selection,
  scope,
  onClose,
  onRenamed,
}: {
  selection: TopicSelection;
  scope: { project: string; start: string; end: string };
  onClose: () => void;
  onRenamed?: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [reload, setReload] = useState(0);
  const [topic, setTopic] = useState<Topic | null>(null);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [complete, setComplete] = useState(false);
  const [conversationsOpen, setConversationsOpen] = useState(false);
  const [cited, setCited] = useState<number | null>(null);
  const summaryAbort = useRef<AbortController | null>(null);
  const payload = JSON.stringify({ selection, ...scope });
  const isWork = selection.kind === "work";
  useEffect(() => {
    const abort = new AbortController();
    setRenaming(false);
    setTopic(null);
    setSummary(null);
    setComplete(false);
    setConversationsOpen(false);
    setCited(null);
    setError("");
    setSummarizing(false);
    void fetch("/api/topic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal: abort.signal,
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not load topic.");
        if (!abort.signal.aborted) {
          setTopic(data);
          setSummary(data.cachedSummary || null);
          setComplete(!!data.cachedSummary);
          if (!data.cachedSummary) void summarize(abort);
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => {
      abort.abort();
      summaryAbort.current?.abort();
    };
  }, [payload, reload]);
  async function summarize(abort = new AbortController()) {
    summaryAbort.current?.abort();
    summaryAbort.current = abort;
    setSummarizing(true);
    setCited(null);
    setSummary(null);
    setComplete(false);
    setError("");
    try {
      const res = await fetch("/api/topic/summary", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        body: payload,
        signal: abort.signal,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Could not summarise topic.");
      }
      if (!res.body) throw new Error("The summary stream is unavailable.");
      let finished = false;
      await readNDJSON(res.body, (message) => {
        if (abort.signal.aborted) return;
        if (message.event === "sources")
          setSummary({ summary: "", sources: message.sources });
        if (message.event === "summary")
          setSummary((previous) => ({ ...previous!, summary: message.text }));
        if (message.event === "done") {
          finished = true;
          setSummary(message.result);
          setComplete(true);
        }
        if (message.event === "error") throw new Error(message.error);
      });
      if (!finished && !abort.signal.aborted)
        throw new Error(
          "The connection ended before the summary finished. Please retry.",
        );
    } catch (e) {
      if (!abort.signal.aborted) setError((e as Error).message);
    } finally {
      if (!abort.signal.aborted) setSummarizing(false);
    }
  }
  function showCitation(index: number) {
    setCited(index);
    setConversationsOpen(true);
    requestAnimationFrame(() => {
      const element = document.getElementById(
        `topic-${summary?.sources[index]?.session}`,
      );
      element?.focus({ preventScroll: true });
      element?.scrollIntoView({ block: "nearest" });
    });
  }
  return (
    <Drawer
      opened
      trapFocus={!renaming}
      closeOnClickOutside={!renaming}
      closeOnEscape={!renaming}
      onClose={onClose}
      size={650}
      title={
        <Group justify="space-between" wrap="nowrap" w="100%">
          <span className="atlas-drawer-label">
            <Network size={15} />
            {isWork ? "Work overview" : "Work stream"}
          </span>
          {!isWork && topic && (
            <Tooltip label="Rename work stream">
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label="Rename work stream"
                onClick={() => setRenaming(true)}
              >
                <Pencil size={16} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      }
      closeButtonProps={{
        "aria-label": isWork ? "Close work overview" : "Close topic",
      }}
      classNames={{ body: "topic-panel" }}
      styles={{ title: { flex: 1, marginRight: "var(--mantine-spacing-xs)" } }}
    >
      {!topic && !error && (
        <p role="status">
          <Loader2 size={16} className="spin" /> Loading{" "}
          {isWork ? "work" : "topic"}…
        </p>
      )}
      <h2 id="topic-title">
        {topic?.title || (isWork ? selection.title : "Topic overview")}
      </h2>
      {topic && (
        <>
          {!isWork && renaming && (
            <SessionRename
              kind="workstream"
              analysisVersion={topic.analysisVersion}
              scope={scope}
              session={{
                id: String(topic.topicId ?? topic.cluster),
                title: topic.title,
              }}
              onClose={() => setRenaming(false)}
              onSaved={() => {
                setRenaming(false);
                setReload((v) => v + 1);
                onRenamed?.();
              }}
            />
          )}
          <div className="topic-meta">
            <span
              className="topic-colour"
              title={
                topic.topicIds && topic.topicIds.length > 1
                  ? `This work spans ${topic.topicIds.length} topics`
                  : "Saved topic colour"
              }
              style={{ background: topic.color }}
            />
            {topic.conversations.length} conversation
            {topic.conversations.length === 1 ? "" : "s"} · {topic.passages}{" "}
            passages
          </div>
          <p className="detail-metadata">
            {formatDate(topic.start)}
            {formatDate(topic.start) !== formatDate(topic.end) &&
              ` – ${formatDate(topic.end)}`}
          </p>
          <div className="topic-projects">
            {topic.projects.map((project) => (
              <span className="soft-badge" key={project}>
                {project}
              </span>
            ))}
          </div>
          <section
            className="topic-summary"
            aria-label="Work summary"
            aria-busy={summarizing}
          >
            <div className="topic-summary-status">
              <span role="status">
                {summarizing ? (
                  <Loader2 size={13} className="spin" />
                ) : complete ? (
                  <Check size={13} />
                ) : null}
                {summarizing
                  ? "Preparing summary…"
                  : complete
                    ? "Summary"
                    : "Summary stopped"}
                {!complete && !summarizing && summary?.summary
                  ? " · partial"
                  : ""}
              </span>
              {summarizing ? (
                <button
                  className="summary-stop"
                  aria-label="Stop summary"
                  title="Stop summary"
                  onClick={() => {
                    summaryAbort.current?.abort();
                    setSummarizing(false);
                  }}
                >
                  <Square size={11} />
                </button>
              ) : !complete ? (
                <button
                  className="text-button"
                  onClick={() => void summarize()}
                >
                  Retry
                </button>
              ) : null}
            </div>
            <div className="topic-summary-body">
              {summary?.summary ? (
                <Markdown
                  className="topic-summary-prose"
                  sources={summary.sources}
                  onCitation={showCitation}
                >
                  {summary.summary}
                </Markdown>
              ) : summarizing ? (
                <div className="summary-placeholder" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </div>
              ) : null}
            </div>
            <small className="topic-summary-note">
              Based on selected supporting passages. Follow a citation to its
              conversation.
            </small>
          </section>
          <details
            open={conversationsOpen}
            onToggle={(event) => setConversationsOpen(event.currentTarget.open)}
            className="topic-conversations"
            aria-label="Related conversations"
          >
            <summary>
              Related conversations <span>({topic.conversations.length})</span>
            </summary>
            <p className="topic-description">
              {isWork
                ? "Discussion supporting this work item within your selected date range."
                : "Conversations grouped by semantic similarity within your selected date range."}
            </p>
            {topic.conversations.map((conversation) => (
              <article
                id={`topic-${conversation.session}`}
                key={conversation.session}
                className="topic-conversation"
                tabIndex={-1}
              >
                <h4>{conversation.title}</h4>
                <div className="detail-metadata">
                  {conversation.provider === "codex" ? "Codex" : "Claude"} ·{" "}
                  {conversation.project} · {formatDate(conversation.end)} ·{" "}
                  {conversation.passages} passage
                  {conversation.passages === 1 ? "" : "s"}
                </div>
                <Markdown>{conversation.preview}</Markdown>
                {cited !== null &&
                  summary?.sources[cited]?.session === conversation.session && (
                    <details className="topic-evidence" open>
                      <summary>
                        Supporting passage [{cited + 1}] ·{" "}
                        {formatDate(summary.sources[cited].timestamp)}
                      </summary>
                      <Markdown>{summary.sources[cited].text}</Markdown>
                    </details>
                  )}
              </article>
            ))}
          </details>
        </>
      )}
      {error && (
        <div className="answer-error" role="alert">
          {error}
        </div>
      )}
    </Drawer>
  );
}
