import { Select } from "@mantine/core";
import { Button } from "@mantine/core";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "./api";

type Call = {
  id: string;
  tool: string;
  client: string;
  version: string;
  status: string;
  started: number;
  duration?: number;
  project: string | null;
  start: string | null;
  end: string | null;
  mode: string | null;
  excerpts?: number;
  sessions?: number;
  characters?: number;
  payloadBytes?: number;
  omitted?: number;
  moreAvailable?: boolean;
  budget?: number;
};
type Activity = {
  total: number;
  retention: number;
  calls: Call[];
  summary: {
    running: number;
    errors: number;
    cancelled: number;
    median: number | null;
    p95: number | null;
    excerpts: number;
    payloadBytes: number;
    clipped: number;
  };
};
const count = (n: number) => n.toLocaleString();
const duration = (n: number | null | undefined) =>
  n == null
    ? "—"
    : n < 1000
      ? `${Math.round(n)} ms`
      : `${(n / 1000).toFixed(1)} s`;
const size = (n = 0) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
const toolName = (name: string) =>
  ({
    atlas_status: "Archive status",
    atlas_search: "Search",
    atlas_read_context: "Read context",
    atlas_activity: "Overview evidence",
    atlas_find_followups: "Find follow-ups",
    atlas_sync: "Sync index",
    read_excerpt: "Read excerpt",
  })[name] || name;
export default function McpActivity({ onSetup }: { onSetup: () => void }) {
  const [hours, setHours] = useState(24),
    [data, setData] = useState<Activity | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    setData(null);
    const refresh = async () => {
      try {
        const next = await api<Activity>(`mcp/activity?hours=${hours}`);
        if (!disposed) {
          setData(next);
          setError("");
        }
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
    };
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [hours]);
  const summary = data?.summary;
  return (
    <section className="mcp-activity" aria-label="MCP activity">
      <div className="mcp-activity-heading">
        <p>See what your assistants retrieve and how long Atlas takes.</p>
        <Select
          aria-label="Activity period"
          w={160}
          style={{ flexShrink: 0 }}
          value={String(hours)}
          onChange={(value) => value && setHours(Number(value))}
          data={[
            { value: "24", label: "Last 24 hours" },
            { value: "168", label: "Last 7 days" },
          ]}
        />
      </div>
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && (
        <p role="status">
          <Loader2 size={16} className="spin" /> Loading activity…
        </p>
      )}
      {data &&
        summary &&
        (data.total ? (
          <>
            <div className="mcp-metrics">
              <div>
                <strong>{count(data.total)}</strong>
                <span>
                  Calls
                  {summary.running > 0 ? ` · ${summary.running} running` : ""}
                </span>
              </div>
              <div>
                <strong>{duration(summary.median)}</strong>
                <span>Median · p95 {duration(summary.p95)}</span>
              </div>
              <div>
                <strong>{size(summary.payloadBytes)}</strong>
                <span>Returned · {count(summary.excerpts)} excerpts</span>
              </div>
            </div>
            {(summary.errors > 0 ||
              summary.cancelled > 0 ||
              summary.clipped > 0) && (
              <p className="mcp-activity-notice">
                {[
                  summary.errors
                    ? `${summary.errors} failed or interrupted`
                    : "",
                  summary.cancelled ? `${summary.cancelled} cancelled` : "",
                  summary.clipped
                    ? `${summary.clipped} with more evidence available`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
            <div className="mcp-call-list">
              {data.calls.map((call) => (
                <details className="mcp-call" key={call.id}>
                  <summary>
                    <span
                      className={`mcp-call-dot ${call.status}`}
                      aria-label={call.status}
                    />
                    <span className="mcp-call-label">
                      <b>{toolName(call.tool)}</b>
                      <small>
                        {call.client} ·{" "}
                        {new Date(call.started).toLocaleString([], {
                          ...(hours === 168
                            ? ({ month: "short", day: "numeric" } as const)
                            : {}),
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </small>
                    </span>
                    <span className="mcp-call-result">
                      {call.status === "running" ? (
                        <>
                          <Loader2 size={13} className="spin" /> Running
                        </>
                      ) : call.status === "success" ? (
                        call.excerpts ? (
                          `${call.excerpts} ${call.excerpts === 1 ? "excerpt" : "excerpts"} · ${size(call.payloadBytes)}`
                        ) : (
                          size(call.payloadBytes)
                        )
                      ) : (
                        call.status
                      )}
                    </span>
                    <span className="mcp-call-duration">
                      {duration(
                        call.status === "running"
                          ? Date.now() - call.started
                          : call.duration,
                      )}
                    </span>
                  </summary>
                  <dl>
                    <dt>Tool</dt>
                    <dd>{call.tool}</dd>
                    <dt>Client</dt>
                    <dd>
                      {call.client}
                      {call.version && ` ${call.version}`}
                    </dd>
                    <dt>Scope</dt>
                    <dd>
                      {call.project || "All permitted projects"}
                      {(call.start || call.end) &&
                        ` · ${call.start || "Beginning"} → ${call.end || "Now"}`}
                    </dd>
                    {call.mode && (
                      <>
                        <dt>Search mode</dt>
                        <dd>{call.mode}</dd>
                      </>
                    )}
                    {call.status === "success" && (
                      <>
                        <dt>Evidence returned</dt>
                        <dd>
                          {count(call.excerpts || 0)} excerpts from{" "}
                          {count(call.sessions || 0)} sessions ·{" "}
                          {count(call.characters || 0)} text characters
                        </dd>
                        <dt>Result JSON</dt>
                        <dd>
                          {size(call.payloadBytes)}
                          {call.budget
                            ? ` · ${count(call.budget)} character evidence budget`
                            : ""}
                        </dd>
                        <dt>Coverage</dt>
                        <dd>
                          {call.omitted
                            ? `${count(call.omitted)} excerpts omitted by budget. `
                            : ""}
                          {call.moreAvailable
                            ? "More evidence is available; the assistant can retrieve it."
                            : "No further results reported by this call."}
                        </dd>
                      </>
                    )}
                    {call.status === "error" && (
                      <>
                        <dt>Outcome</dt>
                        <dd>
                          Request failed. The assistant received the error;
                          error contents aren’t stored here.
                        </dd>
                      </>
                    )}
                    {call.status === "interrupted" && (
                      <>
                        <dt>Outcome</dt>
                        <dd>The server stopped before recording a result.</dd>
                      </>
                    )}
                  </dl>
                </details>
              ))}
            </div>
            {data.total > data.calls.length && (
              <p>
                Showing the latest {data.calls.length} calls in this period.
              </p>
            )}
          </>
        ) : (
          <div className="mcp-activity-empty">
            <h3>No MCP calls in this period</h3>
            <p>
              Connect an assistant and ask it to search your sessions. Its calls
              will appear here as they happen.
            </p>
            <Button variant="default" onClick={onSetup}>
              Set up a connection
            </Button>
          </div>
        ))}
      <details className="mcp-details">
        <summary>About these metrics</summary>
        <p>
          Updates every 2 seconds while open. Keeps the latest 1,000 calls
          locally. Query text and conversation excerpts aren’t logged. Timing
          covers successful Atlas calls, not your assistant’s thinking; sizes
          measure result JSON, not billed tokens. Existing clients need a
          reconnect to start recording.
        </p>
      </details>
    </section>
  );
}
