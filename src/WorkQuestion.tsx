import { ActionIcon } from "@mantine/core";
import Markdown from "./Markdown.js";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  ArrowUp,
  Loader2,
  Square,
  X,
  ChevronDown,
  MessageCircle,
} from "lucide-react";
import { formatDate, type Excerpt } from "./api";
import { readNDJSON } from "../shared/stream.js";
import RunTimings, { type TimingData } from "./RunTimings";
type Item = { id: string; title: string; text: string };
type Evidence = {
  id: string;
  title: string;
  timestamp: string;
  role: string;
  session: string;
  preview: string;
};
type Answer = {
  answer: string;
  sourceIds: string[];
  sources: Excerpt[];
  findings: {
    text: string;
    status: string;
    reason?: string;
    sourceIds: string[];
  }[];
  checkedThrough: string;
  timings?: TimingData;
};
export default function WorkQuestion({
  item,
  scope,
  onClose,
  onSource,
  onBusyChange,
}: {
  item: Item;
  scope: { project: string; start: string; end: string };
  onClose: () => void;
  onSource: (id: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLTextAreaElement>(null),
    controller = useRef<AbortController | null>(null),
    content = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    draft = useRef("");
  const [question, setQuestion] = useState(""),
    [asking, setAsking] = useState(false),
    [answer, setAnswer] = useState<Answer | null>(null),
    [fragments, setFragments] = useState<string[]>([]),
    [liveFindings, setLiveFindings] = useState<Answer["findings"]>([]),
    [sources, setSources] = useState<Evidence[]>([]),
    [error, setError] = useState(""),
    [phase, setPhase] = useState(""),
    [evidenceOpen, setEvidenceOpen] = useState(false);
  const [timings, setTimings] = useState<TimingData>();
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    input.current?.focus();
    return () => {
      controller.current?.abort();
      el?.close();
      document.body.style.overflow = previous;
      onBusyChange(false);
    };
  }, []);
  useEffect(() => {
    if (follow.current && content.current)
      content.current.scrollTop = content.current.scrollHeight;
  }, [fragments, answer, phase, liveFindings]);
  async function ask(submitted = question) {
    const text = submitted.trim();
    if (!text || asking) return;
    const abort = new AbortController();
    controller.current = abort;
    draft.current = "";
    follow.current = true;
    setAsking(true);
    onBusyChange(true);
    setAnswer(null);
    setTimings(undefined);
    setFragments([]);
    setLiveFindings([]);
    setSources([]);
    setError("");
    setPhase("Starting local search…");
    let completed = false;
    try {
      const response = await fetch("/api/insights/ask", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        signal: abort.signal,
        body: JSON.stringify({
          ...scope,
          itemId: item.id,
          mode: /^(?:what[’']?s|what is|what remains) unresolved\??$/i.test(
            text,
          )
            ? "unresolved"
            : "question",
          question: text,
        }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Could not start this question.");
      }
      if (!response.body)
        throw new Error("The response stream is unavailable. Please retry.");
      await readNDJSON(response.body, (message) => {
        if (abort.signal.aborted) return;
        if (message.event === "progress") setPhase(message.text);
        if (message.event === "timings") setTimings(message.timings);
        if (message.event === "sources") setSources(message.sources);
        if (message.event === "reset") {
          draft.current = "";
          setFragments([]);
          setLiveFindings([]);
        }
        if (message.event === "answer") {
          const text = String(message.text),
            previous = draft.current;
          draft.current = text;
          setPhase("Writing answer…");
          setFragments((parts) =>
            text.startsWith(previous)
              ? [...parts, text.slice(previous.length)]
              : [text],
          );
        }
        if (message.event === "finding")
          setLiveFindings((findings) => [...findings, message.finding]);
        if (message.event === "done") {
          completed = true;
          setAnswer(message.result);
          setPhase("");
        }
        if (message.event === "error") throw new Error(message.error);
      });
      if (!completed && !abort.signal.aborted)
        throw new Error(
          "The connection ended before the answer finished. You can retry.",
        );
    } catch (e) {
      if (!abort.signal.aborted) {
        setError((e as Error).message);
        setPhase("");
      }
    } finally {
      if (!abort.signal.aborted) {
        setAsking(false);
        onBusyChange(false);
      }
    }
  }
  function stop() {
    controller.current?.abort();
    setAsking(false);
    onBusyChange(false);
    setPhase("Stopped");
  }
  function openSource(id: string) {
    onClose();
    onSource(id);
  }
  const sessions = new Set(sources.map((s) => s.session)).size;
  return (
    <dialog
      ref={dialog}
      className="work-dialog"
      aria-labelledby="work-dialog-title"
      aria-describedby="work-dialog-description"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <header className="work-dialog-header">
        <div>
          <span className="work-dialog-eyebrow">
            <MessageCircle size={13} />
            Explore your work
          </span>
          <h2 id="work-dialog-title">{item.title}</h2>
          <p id="work-dialog-description">
            Ask about this work using your local conversations.
          </p>
        </div>
        <ActionIcon
          variant="subtle"
          aria-label="Close work question"
          onClick={onClose}
        >
          <X size={18} />
        </ActionIcon>
      </header>
      <form
        className="work-dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <div className="work-question-input">
          <textarea
            ref={input}
            aria-label="Your question"
            placeholder="What would you like to know?"
            value={question}
            maxLength={2000}
            rows={2}
            disabled={asking}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void ask();
              }
            }}
          />
          {asking ? (
            <button
              className="question-submit"
              type="button"
              aria-label="Stop answer"
              onClick={stop}
            >
              <Square size={15} />
            </button>
          ) : (
            <button
              className="question-submit"
              type="submit"
              aria-label="Ask question"
              disabled={!question.trim()}
            >
              <ArrowUp size={18} />
            </button>
          )}
        </div>
        <button
          type="button"
          className="question-suggestion"
          disabled={asking}
          onClick={() => {
            setQuestion("What’s unresolved?");
            void ask("What’s unresolved?");
          }}
        >
          What’s unresolved?
        </button>
      </form>
      <div
        className="work-dialog-content"
        ref={content}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 70;
        }}
      >
        <RunTimings data={answer?.timings || timings} running={asking} />
        {phase && (
          <div className="question-progress" role="status">
            {asking ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <Square size={12} />
            )}
            <span>{phase}</span>
            {asking && (
              <span className="progress-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            )}
          </div>
        )}
        {sources.length > 0 && (
          <div className="question-evidence">
            <button
              className="evidence-toggle"
              onClick={() => setEvidenceOpen(!evidenceOpen)}
              aria-expanded={evidenceOpen}
            >
              {sources.length} excerpts · {sessions} conversations
              <ChevronDown size={13} />
            </button>
            {(evidenceOpen
              ? sources
              : [...sources]
                  .reverse()
                  .filter(
                    (source, index, rows) =>
                      rows.findIndex(
                        (row) => row.session === source.session,
                      ) === index,
                  )
                  .slice(0, 3)
            ).map((source, i) => (
              <div
                className="evidence-row"
                key={source.id}
                style={{ animationDelay: `${i * 45}ms` }}
              >
                <span className="evidence-date">
                  {formatDate(source.timestamp)}
                </span>
                <span className="evidence-title">{source.title}</span>
                <small
                  className={
                    evidenceOpen ? undefined : "evidence-preview-compact"
                  }
                >
                  <Markdown>{source.preview}</Markdown>
                </small>
              </div>
            ))}
          </div>
        )}
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        {!asking && !answer && !fragments.length && !error && (
          <p className="question-empty">
            Find a decision, revisit the reasoning, or check what still needs
            attention.
          </p>
        )}
        {(fragments.length > 0 || liveFindings.length > 0 || answer) && (
          <div className="work-answer" aria-busy={asking}>
            <Markdown
              className="streamed-answer"
              sources={sources}
              onCitation={(index) => openSource(sources[index].id)}
            >
              {answer?.answer || fragments.join("")}
            </Markdown>
            {asking && <span className="stream-caret" aria-hidden="true" />}

            <ul className="answer-findings">
              {(answer?.findings || liveFindings).map((finding, i) => (
                <li key={i} style={{ animationDelay: `${i * 60}ms` }}>
                  <span className="finding-status">
                    {finding.status === "open"
                      ? "Open"
                      : finding.status === "unclear"
                        ? "Unclear"
                        : finding.status === "superseded"
                          ? "Superseded"
                          : "Resolved"}
                  </span>{" "}
                  <Markdown>{finding.text}</Markdown>
                  {finding.reason && (
                    <Markdown className="finding-reason">
                      {finding.reason}
                    </Markdown>
                  )}
                  {finding.sourceIds.map((id) => (
                    <button
                      className="text-button"
                      key={id}
                      onClick={() => openSource(id)}
                    >
                      Source <ArrowUpRight size={10} />
                    </button>
                  ))}
                </li>
              ))}
            </ul>
            {answer && (
              <>
                <div className="answer-sources">
                  {answer.sourceIds.map((id) => {
                    const source = answer.sources.find((s) => s.id === id);
                    return source ? (
                      <button
                        className="text-button"
                        key={id}
                        onClick={() => openSource(id)}
                      >
                        {source.title}
                        <ArrowUpRight size={10} />
                      </button>
                    ) : null;
                  })}
                </div>
                <small className="answer-cutoff">
                  Conversations through{" "}
                  {formatDate(
                    new Date(
                      Date.parse(answer.checkedThrough) - 1,
                    ).toISOString(),
                  )}
                  .
                </small>
              </>
            )}
          </div>
        )}
      </div>
    </dialog>
  );
}
