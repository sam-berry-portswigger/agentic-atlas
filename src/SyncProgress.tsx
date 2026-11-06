import type { SyncJob } from "./api";
import { useRef } from "react";
import { Activity, Loader2 } from "lucide-react";
import { ActionIcon, Popover } from "@mantine/core";
import "./SyncStatus.css";

export const syncPhases = [
  "discovering",
  "importing",
  "embedding",
  "assigning",
  "publishing",
  "projecting",
  "analysing",
  "naming",
];
const labels: Record<string, string> = {
  discovering: "Checking for changed sessions",
  importing: "Reading changed sessions",
  embedding: "Embedding new conversation text",
  assigning: "Updating work streams",
  publishing: "Saving work streams",
  analysing: "Updating work streams",
  naming: "Naming topics",
  projecting: "Updating the map",
};
const units: Record<string, string> = {
  importing: "files checked",
  embedding: "passages embedded",
  assigning: "sessions updated",
  projecting: "map steps",
};

export function SyncProgress({
  job,
  onPause,
}: {
  job: SyncJob;
  onPause: () => void;
}) {
  const determinate =
    job.indeterminate !== true && job.total > 0 && !!units[job.phase];
  return (
    <div className="sync-status-card sync-status-running" role="status">
      <Loader2 size={17} className="sync-status-spinner" aria-hidden="true" />
      <div className="sync-status-content">
        <b>{labels[job.phase] || "Updating sessions"}</b>
        <small>
          {determinate
            ? `${job.done.toLocaleString()} / ${job.total.toLocaleString()} ${units[job.phase]}`
            : job.detail || "Working locally"}
          {job.elapsedMs !== undefined &&
            ` · ${Math.floor(job.elapsedMs / 1000)}s elapsed`}
        </small>
        {determinate && (
          <progress
            aria-label={labels[job.phase]}
            max={job.total}
            value={Math.min(job.done, job.total)}
            className="sync-status-meter"
          />
        )}
        {job.contentReady && !job.assignmentsReady && (
          <small>Conversation text is ready; work streams are updating.</small>
        )}
      </div>
      <button className="sync-status-pause" onClick={onPause}>
        Pause
      </button>
    </div>
  );
}

export function SyncWarnings({
  job,
  namingPending = false,
  onRetry,
}: {
  job?: SyncJob;
  namingPending?: boolean;
  onRetry?: () => void;
}) {
  if (!namingPending && !job?.warnings?.length) return null;
  const busy = !!job && syncPhases.includes(job.phase);
  return (
    <div className="td-alert" role="status">
      <span>
        {namingPending
          ? "Sessions are indexed, but work-stream naming is incomplete."
          : `${job?.contentReady ? "Sessions are ready. " : ""}${job?.warnings?.join(" ")}`}
      </span>
      {namingPending && onRetry && (
        <button disabled={busy} onClick={onRetry}>
          Retry naming
        </button>
      )}
    </div>
  );
}

export function SyncSummary({ job }: { job?: SyncJob }) {
  const last = useRef<SyncJob | null>(null);
  if (job?.phase === "complete" && job.stages?.length) last.current = job;
  const completed = last.current;
  if (!completed) return null;
  return (
    <div className="sync-status-details">
      <strong>
        {completed.assignmentsReady
          ? "Sessions and work streams are up to date"
          : "Conversation text is up to date"}
      </strong>
      <p>
        {completed.elapsedMs !== undefined &&
          `${(completed.elapsedMs / 1000).toFixed(1)}s total`}
        {completed.mapPending && " · Map update available in Explore"}
      </p>
      <ul>
        {completed.stages?.map((stage, index) => (
          <li key={index}>
            {stage.phase === "embedding" && stage.total === 0
              ? "Embeddings already up to date"
              : labels[stage.phase] || stage.phase}
            :{" "}
            {units[stage.phase] && stage.total > 0
              ? `${stage.done.toLocaleString()} / ${stage.total.toLocaleString()} ${units[stage.phase]} · `
              : ""}
            {(stage.elapsedMs / 1000).toFixed(1)}s
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SyncStatus({
  job,
  onPause,
}: {
  job?: SyncJob;
  onPause: () => void;
}) {
  const last = useRef<SyncJob | null>(null);
  if (job?.phase === "complete" && job.stages?.length) last.current = job;
  const running = !!job && syncPhases.includes(job.phase);
  return (
    <Popover position="bottom-end" width={360} withinPortal shadow="md">
      <Popover.Target>
        <ActionIcon
          variant="subtle"
          aria-label="Sync status"
          title="Sync status"
        >
          {running ? (
            <Loader2 size={17} className="sync-status-spinner" />
          ) : (
            <Activity size={17} />
          )}
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown className="sync-status-popover">
        {running ? (
          <SyncProgress job={job} onPause={onPause} />
        ) : last.current ? (
          <SyncSummary job={last.current} />
        ) : (
          <span>No completed sync details yet.</span>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}
