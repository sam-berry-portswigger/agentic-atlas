import { ActionIcon, Button } from "@mantine/core";
import Markdown from "./Markdown.js";
import { citationNumbers } from "../shared/markdown.js";
import { useEffect, useRef, useState } from "react";
import { Copy, Check, Loader2, Square, X, ArrowUpRight } from "lucide-react";
import { readNDJSON } from "../shared/stream.js";
import { formatDate } from "./api";
import RunTimings, { type TimingData } from "./RunTimings";
export type SearchRequest = {
  key: number;
  query: string;
  mode: "agent" | "normal" | "hyde";
  summarize: boolean;
  project: string;
  start: string;
  end: string;
};
type Source = {
  id: string;
  title?: string;
  project: string;
  session: string;
  timestamp: string;
};
type Result = {
  answer: string;
  summary?: boolean;
  context?: string;
  sources: Source[];
  elapsed: number;
  limited: boolean;
  timings?: TimingData;
  verification?: {
    evidenceThrough: string | null;
    statusQuestion: boolean;
    investigation?: {
      queries: string[];
      reads?: string[];
      limited: boolean;
      reason: string;
    };
  };
};
export default function SearchAnswer({
  request,
  onBusy,
  onSources,
  onSource,
  onClear,
}: {
  request: SearchRequest;
  onBusy: (busy: boolean) => void;
  onSources: (ids: string[]) => void;
  onSource: (id: string) => void;
  onClear: () => void;
}) {
  const [result, setResult] = useState<Result | null>(null),
    [sources, setSources] = useState<Source[]>([]),
    [fragments, setFragments] = useState<string[]>([]),
    [phase, setPhase] = useState("Starting local search…"),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [copied, setCopied] = useState(false),
    [retry, setRetry] = useState(0);
  const [timings, setTimings] = useState<TimingData>();
  const controller = useRef<AbortController | null>(null),
    draft = useRef("");
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    draft.current = "";
    setResult(null);
    setTimings(undefined);
    setSources([]);
    setFragments([]);
    setError("");
    setCopied(false);
    setBusy(true);
    onBusy(true);
    onSources([]);
    setPhase("Starting local search…");
    let completed = false;
    void (async () => {
      try {
        await Promise.resolve();
        if (abort.signal.aborted) return;
        const response = await fetch("/api/search/answer", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/x-ndjson",
          },
          body: JSON.stringify(request),
          signal: abort.signal,
        });
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || "Could not start search.");
        }
        if (!response.body)
          throw new Error("The response stream is unavailable.");
        await readNDJSON(response.body, (message) => {
          if (abort.signal.aborted) return;
          if (message.event === "progress") setPhase(message.text);
          if (message.event === "timings") setTimings(message.timings);
          if (message.event === "sources") {
            setSources(message.sources);
            onSources(
              message.sources.flatMap((source: Source) => [
                source.id,
                source.session,
              ]),
            );
          }
          if (message.event === "answer") {
            const text = String(message.text),
              previous = draft.current;
            draft.current = text;
            setPhase("Writing your answer…");
            setFragments((parts) =>
              text.startsWith(previous)
                ? [...parts, text.slice(previous.length)]
                : [text],
            );
          }
          if (message.event === "done") {
            completed = true;
            setResult(message.result);
            setPhase("");
          }
          if (message.event === "error") throw new Error(message.error);
        });
        if (!completed && !abort.signal.aborted)
          throw new Error(
            "The connection ended before the answer finished. Please retry.",
          );
      } catch (e) {
        if (!abort.signal.aborted) {
          setError((e as Error).message);
          setPhase("");
        }
      } finally {
        if (!abort.signal.aborted) {
          setBusy(false);
          onBusy(false);
        }
      }
    })();
    return () => {
      abort.abort();
      onBusy(false);
    };
  }, [request, retry]);
  const text = result?.answer || fragments.join("");
  async function copy() {
    const citedNumbers = new Set(citationNumbers(text));
    const citations = sources
      .map((source, i) =>
        citedNumbers.has(i + 1)
          ? `[${i + 1}] ${source.project} · ${formatDate(source.timestamp)}\nSession: ${source.session} · atlas://excerpt/${source.id}`
          : "",
      )
      .filter(Boolean)
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(
        result?.summary === false
          ? `${request.query}\n\n${result.context || ""}`
          : `${request.query}\n\n${text}${citations ? `\n\nSources\n${citations}` : ""}`,
      );
      setCopied(true);
    } catch {
      setError("Clipboard unavailable. Select and copy the answer text below.");
    }
  }
  return (
    <section
      className="search-answer"
      id="search-answer"
      aria-labelledby="search-answer-title"
      aria-busy={busy}
    >
      <header>
        <div>
          <span className="answer-eyebrow">From your conversations</span>
          <h2 id="search-answer-title">{request.query}</h2>
        </div>
        <div className="answer-actions">
          {busy ? (
            <button
              className="text-button"
              onClick={() => {
                controller.current?.abort();
                setBusy(false);
                onBusy(false);
                setPhase("Stopped");
              }}
            >
              <Square size={12} />
              Stop
            </button>
          ) : (
            result && (
              <button className="text-button" onClick={() => void copy()}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied
                  ? "Copied"
                  : result.summary === false
                    ? "Copy context"
                    : "Copy answer"}
              </button>
            )
          )}
          <ActionIcon
            variant="subtle"
            aria-label="Clear search"
            onClick={onClear}
          >
            <X size={16} />
          </ActionIcon>
        </div>
      </header>
      {phase && (
        <div className="answer-progress" role="status">
          {busy && <Loader2 size={14} className="spin" />}
          {phase}
        </div>
      )}
      {result ? (
        result.summary === false ? (
          <div className="retrieval-results">
            <p>
              {sources.length
                ? "Relevant conversations are highlighted on the map. Open a source or copy the retrieved context."
                : "No relevant conversations found in this scope. Try a wider date range or another query."}
            </p>
            <div>
              {[
                ...new Map(
                  sources.map((source) => [source.session, source]),
                ).values(),
              ].map((source) => (
                <Button
                  key={source.session}
                  variant="default"
                  justify="space-between"
                  className="atlas-search-source"
                  styles={{ label: { whiteSpace: "normal", flex: 1 } }}
                  onClick={() => onSource(source.id)}
                >
                  <span>
                    <strong>
                      {source.title ||
                        `Conversation ${source.session.slice(-8)}`}
                    </strong>
                    <small>
                      {source.project || "No project"} ·{" "}
                      {formatDate(source.timestamp)} ·{" "}
                      {new Date(source.timestamp).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </small>
                  </span>
                  <ArrowUpRight size={15} />
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <Markdown
            className="answer-prose"
            sources={sources}
            onCitation={(index) => onSource(sources[index].id)}
          >
            {result.answer}
          </Markdown>
        )
      ) : (
        text && (
          <Markdown
            className="answer-prose"
            sources={sources}
            onCitation={(index) => onSource(sources[index].id)}
          >
            {text}
          </Markdown>
        )
      )}
      {error && (
        <div className="answer-error" role="alert">
          <p>{error}</p>
          {!busy && !result && (
            <button
              className="text-button"
              onClick={() => setRetry((value) => value + 1)}
            >
              Try again
            </button>
          )}
        </div>
      )}
      {!busy && !result && !error && phase === "Stopped" && (
        <button
          className="text-button"
          onClick={() => setRetry((value) => value + 1)}
        >
          Try again
        </button>
      )}
      {result && sources.length > 0 && (
        <footer>
          <span>
            Based on {new Set(sources.map((source) => source.session)).size}{" "}
            conversations{result.limited ? " · Selected relevant context" : ""}
            {result.verification?.investigation && (
              <>
                {" "}
                · {result.verification.investigation.queries.length} searches
                {result.verification.investigation.reads?.length
                  ? ` · ${result.verification.investigation.reads.length} source reads`
                  : ""}
              </>
            )}
            {result.verification?.statusQuestion &&
              result.verification.evidenceThrough && (
                <span className="answer-evidence-date">
                  {" "}
                  · Latest evidence{" "}
                  {new Date(result.verification.evidenceThrough).toLocaleString(
                    "en-GB",
                    {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    },
                  )}
                </span>
              )}
          </span>
          <span>{(result.elapsed / 1000).toFixed(1)}s</span>
        </footer>
      )}
      {result?.verification?.investigation && (
        <details className="answer-investigation">
          <summary>Investigation</summary>
          <ol>
            {result.verification.investigation.queries.map((query, index) => (
              <li key={index}>{query}</li>
            ))}
          </ol>
          {result.verification.investigation.limited && (
            <p>
              Investigation used a bounded sample. Further evidence may exist.
            </p>
          )}
        </details>
      )}
      <RunTimings data={result?.timings || timings} running={busy} />
    </section>
  );
}
