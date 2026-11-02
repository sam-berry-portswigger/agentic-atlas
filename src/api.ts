export type Excerpt = {
  id: string;
  session: string;
  project: string;
  title: string;
  role: string;
  timestamp: string;
  text: string;
  score?: number;
};
export type Point = {
  id: string;
  session?: string;
  project: string;
  title: string;
  role: string;
  timestamp: string;
  x: number;
  y: number;
  cluster: number;
  preview: string;
  approximate?: boolean;
  color: string;
  topicName: string;
  analysisVersion: string;
};
export type Config = {
  source: string;
  codexSource: string;
  embeddingModel: string;
  generationModel: string;
};
export type SyncJob = {
  startedAt?: string;
  id?: string;
  phase: string;
  done: number;
  total: number;
  detail?: string;
  error?: string;
  indeterminate?: boolean;
  elapsedMs?: number;
  stageElapsedMs?: number;
  updatedAt?: string;
  lastProgressAt?: string;
  warnings?: string[];
  contentReady?: boolean;
  assignmentsReady?: boolean;
  mapPending?: boolean;
  stages?: {
    phase: string;
    done: number;
    total: number;
    elapsedMs: number;
    complete: boolean;
  }[];
};
export type Status = {
  autoSync?: {
    paused: boolean;
    lastSuccessfulAt: string | null;
    nextCheckAt: string | null;
  };
  analysis: {
    version: string | null;
    stale: boolean;
    topics: number;
    generatedAt?: string;
    mapPending?: boolean;
    contentUpdatedAt?: string;
    assignmentsUpdatedAt?: string;
    mapUpdatedAt?: string;
  };
  insightsJob?: { phase: string };
  config: Config;
  job: SyncJob;
  counts: {
    excerpts: number;
    sessions: number;
    projects: number;
    embedded: number;
    latest: string;
  };
  projects: { project: string; count: number }[];
  ollama: {
    connected: boolean;
    models: { name: string; size: number }[];
    error?: string;
  };
  hardware: { arch: string; memory: number; chip: string };
};
export async function api<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(
    `/api/${route}`,
    body !== undefined
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
export function formatDate(value: string) {
  if (!value) return "Undated";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "Undated"
    : d.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}
export function sourceText(rows: Excerpt[]) {
  return rows
    .map(
      (r, i) =>
        `[${i + 1}] ${r.project} — ${r.title}\nSession: ${r.session}\n${formatDate(r.timestamp)} · ${r.role}\n\n${r.text}`,
    )
    .join("\n\n---\n\n");
}
