import { Button } from "@mantine/core";
import Markdown from "./Markdown.js";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  MessageCircle,
  Check,
  Copy,
  Loader2,
  Pause,
  Sparkles,
} from "lucide-react";
import { api, formatDate, type Excerpt } from "./api";
import type { TopicSelection } from "./TopicOverview";
import WorkQuestion from "./WorkQuestion";
import RunTimings, { type TimingData } from "./RunTimings";
type FocusItem = {
  id: string;
  title: string;
  text: string;
  clusters: number[];
  sourceIds: string[];
  links: {
    title: string;
    sourceIds: string[];
    cluster: number;
    streamId?: number;
    workId?: string;
    analysisVersion?: string;
    color?: string | null;
  }[];
};
export type Topic = {
  cluster: number;
  title: string;
  sources: Excerpt[];
  sourceIds: string[];
};
type InsightData = {
  topics: Topic[];
  overview: { summary?: string; focus: FocusItem[] } | null;
  stale: boolean;
  method?: string;
  active: boolean;
  timings?: TimingData;
  freshness?: { pending: boolean };
  job: { phase: string; error?: string; scope?: unknown; timings?: TimingData };
};
export default function WorkOverview({
  scope,
  query,
  period,
  indexing,
  onFocus,
  onSource,
  onWorkItem,
}: {
  scope: { start: string; end: string; project: string };
  query: string;
  period: string;
  indexing: boolean;
  onFocus: (cluster: number | null) => void;
  onSource: (id: string) => void;
  onWorkItem: (selection: TopicSelection) => void;
}) {
  const [data, setData] = useState<InsightData | null>(null),
    [error, setError] = useState(""),
    [starting, setStarting] = useState(false),
    [copied, setCopied] = useState(false);
  const [selected, setSelected] = useState<FocusItem | null>(null),
    [asking, setAsking] = useState(false);
  const version = useRef(0);
  useEffect(() => {
    let mounted = true;
    const current = ++version.current;
    setData(null);
    setError("");
    setSelected(null);
    setAsking(false);
    async function refresh() {
      try {
        const next = await api<InsightData>("insights?" + query);
        if (mounted && current === version.current) {
          setData(next);
        }
      } catch (e) {
        if (mounted) setError((e as Error).message);
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [query]);
  const active = !!data?.active;
  async function generate() {
    setStarting(true);
    setError("");
    const current = version.current;
    try {
      await api("insights/generate", {
        ...scope,
        periodLabel:
          period === "Custom dates"
            ? `${formatDate(scope.start)} – ${formatDate(new Date(Date.parse(scope.end) - 1).toISOString())}`
            : period === "All time"
              ? "Across your indexed history"
              : period,
        force: true,
      });
      const next = await api<InsightData>("insights?" + query);
      if (current === version.current) setData(next);
    } catch (e) {
      if (current === version.current) setError((e as Error).message);
    } finally {
      if (current === version.current) setStarting(false);
    }
  }
  async function copy() {
    if (!data?.overview) return;
    try {
      await navigator.clipboard.writeText(
        [
          `Work overview · ${period}`,
          data.overview.summary || "",
          ...data.overview.focus.map((item) => `${item.title}\n${item.text}`),
        ].join("\n\n"),
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(
        "Clipboard access is unavailable. Copy the visible text manually.",
      );
    }
  }
  return (
    <section className="work-overview">
      <div className="work-overview-header">
        <h2>Work overview</h2>
        <div>
          {!!data?.overview && (
            <button className="text-button" onClick={() => void copy()}>
              {copied ? <Check size={12} /> : <Copy size={12} />}{" "}
              {copied ? "Copied" : "Copy"}
            </button>
          )}
          <Button
            variant="default"
            disabled={starting || indexing || asking}
            onClick={() =>
              active
                ? void api("insights/stop", {}).catch((e) =>
                    setError(e.message),
                  )
                : void generate()
            }
          >
            {starting ? (
              <Loader2 size={13} className="spin" />
            ) : active ? (
              <Pause size={13} />
            ) : (
              <Sparkles size={13} />
            )}{" "}
            {active
              ? "Pause"
              : data?.overview
                ? "Refresh overview"
                : "Summarise work"}
          </Button>
        </div>
      </div>
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {data?.job.phase === "error" &&
        JSON.stringify(data.job.scope) === JSON.stringify(scope) && (
          <div className="alert error" role="alert">
            {data.job.error}
          </div>
        )}
      {active && (
        <div className="work-generating">
          <Loader2 size={13} className="spin" />
          <span>
            {data?.job.phase === "syncing"
              ? "Updating sessions…"
              : "Finding what’s in focus…"}
          </span>
        </div>
      )}
      {!active && (data?.stale || data?.freshness?.pending) && (
        <div className="insight-stale">
          {data?.method && data.method !== "shared-stream-summary-v1"
            ? "Refresh to focus on substantive work and group related conversations."
            : "New conversations are available. Refresh to include them."}
        </div>
      )}
      {!data?.overview && !active && (
        <div className="overview-intro">
          <p>
            See what you’ve been working on, then explore any item when you need
            more detail.
          </p>
        </div>
      )}
      {data?.overview && (
        <div className="focus-list">
          {data.overview.summary && (
            <Markdown className="focus-summary">
              {data.overview.summary}
            </Markdown>
          )}
          <h3 className="focus-label">In focus</h3>
          {data.overview.focus.map((item) => (
            <article className="focus-item" key={item.id}>
              <h4 className="stream-summary-title">{item.title}</h4>
              <Markdown>{item.text}</Markdown>
              <div className="focus-footer">
                <div className="focus-source-links">
                  {item.links?.map((link, i) => (
                    <button
                      key={`${link.title}-${i}`}
                      onClick={() =>
                        onWorkItem(
                          link.streamId !== undefined
                            ? {
                                kind: "stream",
                                streamId: link.streamId,
                                analysisVersion: link.analysisVersion,
                              }
                            : {
                                kind: "work",
                                title: link.title,
                                sourceIds: link.sourceIds,
                                workId: link.workId,
                                analysisVersion: link.analysisVersion,
                              },
                        )
                      }
                      style={{
                        color: link.color
                          ? `color-mix(in srgb, ${link.color} 65%, #25342d)`
                          : "var(--muted)",
                      }}
                    >
                      {link.title}
                      <ArrowUpRight size={10} />
                    </button>
                  ))}
                </div>
                <div className="focus-actions">
                  <button
                    className="explore-button"
                    disabled={active || indexing}
                    onClick={() => setSelected(item)}
                  >
                    <MessageCircle size={14} />
                    Ask a question
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      <RunTimings
        data={
          JSON.stringify(data?.job.scope) === JSON.stringify(scope) &&
          (active ||
            data?.job.phase === "error" ||
            data?.job.phase === "paused")
            ? data?.job.timings
            : data?.timings
        }
        running={active}
      />
      {selected && (
        <WorkQuestion
          key={selected.id}
          item={selected}
          scope={scope}
          onClose={() => setSelected(null)}
          onSource={onSource}
          onBusyChange={setAsking}
        />
      )}
    </section>
  );
}
