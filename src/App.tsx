import {
  Checkbox,
  Autocomplete,
  Modal,
  Stack,
  Text,
  TextInput,
  SegmentedControl,
  Select,
  Switch,
} from "@mantine/core";
import { ActionIcon, Button } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import {
  CalendarDays,
  ArrowRight,
  ChevronDown,
  CircleHelp,
  Cpu,
  Loader2,
  Network,
  Pause,
  Plug,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { api, type Config, type Point, type Status, type SyncJob } from "./api";
import { SyncStatus, SyncWarnings, syncPhases } from "./SyncProgress";
import { notify } from "./ui/notify";
import TopicOverview, { type TopicSelection } from "./TopicOverview";
import SourceDetails from "./SourceDetails";
import EmbeddingMap from "./EmbeddingMap";
import TodayView from "./TodayView";
import WorkOverview from "./WorkOverview";
import McpSetup from "./McpSetup";
import FirstTimeSetup from "./FirstTimeSetup";
import SearchAnswer, { type SearchRequest } from "./SearchAnswer";
import { dateRange } from "../shared/dates.js";
import { catalogueRevision } from "../shared/catalogue-revision.js";
import { AppearanceControls } from "./ui/Appearance";
const busyPhases = syncPhases;
export default function App() {
  const [page, setPage] = useState(() => {
    const view = new URLSearchParams(location.search).get("view");
    return view === "explore" || view === "mcp" ? view : "today";
  });
  const pageRef = useRef(page);
  pageRef.current = page;
  function navigate(next: string) {
    setPage(next);
    const url = new URL(location.href);
    url.searchParams.set("view", next);
    history.replaceState(null, "", url);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  useEffect(() => {
    if (page === "explore") {
      void refresh();
      void loadMap();
    }
  }, [page]);
  const [period, setPeriod] = useState("week"),
    [customStart, setCustomStart] = useState(() => localDay(-6)),
    [customEnd, setCustomEnd] = useState(() => localDay(0));
  const [mapTopics, setMapTopics] = useState<
    { cluster: number; title: string; color: string }[]
  >([]);
  const mapVersion = useRef<string | null>(null);
  const mapRevision = useRef<string | null>(null);
  const [fadeOlder, setFadeOlder] = useState(false);
  const [regionsMode, setRegionsMode] = useState(false);
  const [topicLabels, setTopicLabels] = useState<Record<number, string>>({}),
    [activeCluster, setActiveCluster] = useState<number | null>(null);
  const [searchRequest, setSearchRequest] = useState<SearchRequest | null>(
    null,
  );
  const [searchIds, setSearchIds] = useState<string[]>([]);
  const [status, setStatus] = useState<Status | null>(null),
    [points, setPoints] = useState<Point[]>([]);
  const [aiSummary, setAiSummary] = useState(true);
  const [query, setQuery] = useState(""),
    [mode, setMode] = useState<"agent" | "normal" | "hyde">("agent");
  const range = dateRange(period, customStart, customEnd);
  const periodLabel = (
    {
      all: "All time",
      today: "Today",
      week: "This week",
      "7days": "Last 7 days",
      month: "This month",
      custom: "Custom dates",
    } as Record<string, string>
  )[period];
  const scope = { project: "", start: range.start, end: range.end };
  const scopedQuery = new URLSearchParams(scope).toString();
  const scopeRef = useRef(scopedQuery);
  scopeRef.current = scopedQuery;
  const rangeInvalid = !!range.error;
  const [detail, setDetail] = useState<
      TopicSelection | { kind: "source"; id: string } | null
    >(null),
    [error, setError] = useState("");
  const [searching, setSearching] = useState(false),
    [settings, setSettings] = useState(false),
    [settingsGuide, setSettingsGuide] = useState(false),
    [settingsError, setSettingsError] = useState(""),
    [help, setHelp] = useState(false),
    [mcpInitialView, setMcpInitialView] = useState<"activity" | "setup">(
      "activity",
    );
  const [draft, setDraft] = useState<Config | null>(null),
    [saving, setSaving] = useState(false),
    [syncing, setSyncing] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    previousPhase = useRef("");
  const metadataAt = useRef(0),
    metadataInflight = useRef(false),
    jobsInflight = useRef(false),
    jobRevision = useRef<string | null>(null);
  const busy = !!status && busyPhases.includes(status.job.phase);
  const highlights = new Set(searchIds);
  async function refresh() {
    if (metadataInflight.current) return;
    metadataInflight.current = true;
    try {
      const current = scopeRef.current;
      const next = await api<Status>("status?" + current);
      if (current !== scopeRef.current) return;
      setStatus(next);
      metadataAt.current = Date.now();
      jobRevision.current = catalogueRevision(next.analysis);
      if (jobRevision.current !== mapRevision.current) void loadMap();
      if (next.job.phase !== previousPhase.current) {
        const oldPhase = previousPhase.current;
        previousPhase.current = next.job.phase;
        if (
          ["complete", "paused", "error"].includes(next.job.phase) ||
          oldPhase === "projecting"
        )
          void loadMap();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      metadataInflight.current = false;
    }
  }
  async function refreshJob() {
    if (document.hidden || jobsInflight.current) return;
    jobsInflight.current = true;
    try {
      const next = await api<{
        job: SyncJob;
        insightsJob?: Status["insightsJob"];
        analysisVersion: string | null;
        catalogueRevision: string | null;
        autoSync?: Status["autoSync"];
      }>(`jobs?today=${pageRef.current === "today" ? "1" : "0"}`);
      setStatus((current) =>
        current
          ? {
              ...current,
              job: next.job,
              insightsJob: next.insightsJob,
              autoSync: next.autoSync,
            }
          : current,
      );
      const changed =
        next.job.phase !== previousPhase.current ||
        next.catalogueRevision !== jobRevision.current;
      const catalogueChanged = next.catalogueRevision !== jobRevision.current;
      jobRevision.current = next.catalogueRevision;
      if (
        (next.job.phase === "complete" &&
          next.job.phase !== previousPhase.current) ||
        catalogueChanged
      )
        void loadMap();
      previousPhase.current = next.job.phase;
      if (changed || Date.now() - metadataAt.current >= 30000) void refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      jobsInflight.current = false;
    }
  }
  async function loadMap() {
    if (pageRef.current === "today") return;
    try {
      const current = scopeRef.current;
      const currentRevision = jobRevision.current;
      const data = await api<{
        points: Point[];
        topics: { cluster: number; title: string; color: string }[];
        analysisVersion: string | null;
      }>("map?" + current);
      if (current === scopeRef.current) {
        setPoints(data.points);
        setMapTopics(data.topics);
        setActiveCluster((selected) =>
          selected !== null &&
          !data.topics.some((topic) => topic.cluster === selected)
            ? null
            : selected,
        );
        setTopicLabels(
          Object.fromEntries(data.topics.map((t) => [t.cluster, t.title])),
        );
        mapVersion.current = data.analysisVersion;
        mapRevision.current = currentRevision;
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refreshJob();
    const timer = setInterval(() => void refreshJob(), 1000);
    const show = () => {
      if (!document.hidden) void refreshJob();
    };
    document.addEventListener("visibilitychange", show);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", show);
    };
  }, []);
  useEffect(() => {
    setSearchRequest(null);
    setSearchIds([]);
    setTopicLabels({});
    setActiveCluster(null);
    setPoints([]);
    if (!rangeInvalid) {
      void refresh();
      void loadMap();
    }
  }, [scopedQuery, rangeInvalid]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key === "k" &&
        pageRef.current === "explore" &&
        !document.querySelector('[role="dialog"], dialog[open]')
      ) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  function search(e?: React.FormEvent) {
    e?.preventDefault();
    if (!query.trim() || searching || rangeInvalid) return;
    setError("");
    setSearching(true);
    setSearchRequest({
      key: Date.now(),
      query: query.trim(),
      mode,
      summarize: aiSummary,
      ...scope,
    });
    requestAnimationFrame(() =>
      document.getElementById("search-answer")?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
        block: "start",
      }),
    );
  }
  function clearSearch() {
    setSearchRequest(null);
    setSearchIds([]);
    setQuery("");
  }
  async function sync() {
    setSyncing(true);
    setError("");
    try {
      await api("sync", {});
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }
  function openPoint(id: string) {
    setDetail({
      kind: "cluster",
      id,
      analysisVersion:
        points.find((point) => point.id === id)?.analysisVersion ||
        mapVersion.current ||
        undefined,
    });
  }
  async function save() {
    if (!draft) return;
    setSaving(true);
    setSettingsError("");
    try {
      await api("config", draft);
      setSettings(false);
      await refresh();
      await loadMap();
      notify("Settings saved");
    } catch (e) {
      setSettingsError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  function openSettings() {
    setDraft(status?.config || null);
    setSettingsError("");
    setSettings(true);
    setSettingsGuide(false);
  }
  function openSetupGuide() {
    if (!settings) {
      setDraft(status?.config || null);
      setSettingsError("");
    }
    setHelp(false);
    setSettingsGuide(true);
    setSettings(true);
  }
  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const stats = rangeInvalid ? undefined : status?.counts;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Atlas home">
          <svg
            className="brand-mark"
            viewBox="0 0 40 40"
            fill="none"
            aria-hidden="true"
          >
            <path d="M8 25C10 16 14 10 21 8C29 11 33 16 33 24C31 31 27 34 22 33C15 34 10 31 8 25Z" />
            <path d="M8 25C16 19 25 19 33 24M21 8C18 17 18 25 22 33" />
            <circle cx="21" cy="8" r="4" fill="#81b7a0" />
            <circle cx="8" cy="25" r="3.5" fill="#a28bdb" />
            <circle cx="33" cy="24" r="3.5" fill="#83b6d9" />
            <circle cx="22" cy="33" r="3" fill="#c4bc6c" />
          </svg>
          <span className="brand-wordmark">
            <strong>Atlas</strong>
            <span>Work in context</span>
          </span>
        </a>
        <nav>
          <button
            className={page === "today" ? "active" : ""}
            onClick={() => navigate("today")}
          >
            <CalendarDays size={17} />
            Today
          </button>
          <button
            className={page === "explore" ? "active" : ""}
            onClick={() => {
              navigate("explore");
              clearSearch();
            }}
          >
            <Network size={17} />
            Explore
          </button>
          <button
            className={page === "mcp" ? "active" : ""}
            onClick={() => navigate("mcp")}
          >
            <Plug size={17} />
            MCP
          </button>
          <button onClick={openSettings}>
            <Settings2 size={17} />
            Settings & models
          </button>
        </nav>
      </aside>
      <main>
        <div className="main-content">
          <nav className="atlas-mobile-nav" aria-label="Workspace">
            <button
              className={page === "today" ? "active" : ""}
              onClick={() => navigate("today")}
            >
              <CalendarDays size={14} />
              Today
            </button>
            <button
              className={page === "explore" ? "active" : ""}
              onClick={() => navigate("explore")}
            >
              <Network size={14} />
              Explore
            </button>
            <button
              className={page === "mcp" ? "active" : ""}
              onClick={() => navigate("mcp")}
            >
              <Plug size={14} />
              MCP
            </button>
            <button aria-label="Settings" onClick={openSettings}>
              <Settings2 size={14} />
            </button>
          </nav>
          {page === "mcp" ? (
            <McpSetup project="" initialView={mcpInitialView} />
          ) : page === "today" ? (
            <TodayView
              taskScope={scopedQuery}
              onAgentSetup={() => {
                setMcpInitialView("setup");
                navigate("mcp");
              }}
              analysisJob={status?.job}
              namingPending={!!status?.analysis.namingPending}
              autoSync={status?.autoSync}
              onOpenStream={(streamId, streamScope) =>
                setDetail({ kind: "stream", streamId, scope: streamScope })
              }
            />
          ) : (
            <>
              <section className="page-heading">
                <div className="page-intro">
                  <h1>{greeting}</h1>
                  <p>
                    Explore the ideas, decisions and progress across your
                    conversations.
                  </p>
                </div>
                <div className="page-actions">
                  {" "}
                  <ActionIcon
                    variant="subtle"
                    aria-label="Help"
                    onClick={() => setHelp(true)}
                  >
                    <CircleHelp size={17} />
                  </ActionIcon>{" "}
                  <SyncStatus
                    job={status?.job}
                    onPause={() =>
                      void api("stop", {}).catch((e) => setError(e.message))
                    }
                  />
                  <Button
                    variant="default"
                    className="sync-button"
                    disabled={
                      syncing ||
                      (!!status?.insightsJob &&
                        [
                          "syncing",
                          "grouping",
                          "summarizing",
                          "checking",
                          "overview",
                          "analysing",
                          "naming",
                          "projecting",
                        ].includes(status.insightsJob.phase))
                    }
                    onClick={() =>
                      busy
                        ? void api("stop", {})
                            .then(() =>
                              notify(
                                "Pausing after the current batch…",
                                "info",
                              ),
                            )
                            .catch((e) => setError(e.message))
                        : void sync()
                    }
                  >
                    {syncing ? (
                      <Loader2 size={14} className="spin" />
                    ) : busy ? (
                      <Pause size={14} />
                    ) : (
                      <RefreshCw size={14} />
                    )}{" "}
                    {busy ? "Pause indexing" : "Sync sessions"}
                  </Button>
                </div>
              </section>
              {error && (
                <div className="alert error" role="alert">
                  <span>{error}</span>
                  <button
                    aria-label="Dismiss error"
                    onClick={() => setError("")}
                  >
                    <X size={15} />
                  </button>
                </div>
              )}
              {status?.job.phase === "error" &&
                status.job.error &&
                status.job.error !== error && (
                  <div className="alert error">
                    <span>
                      {status.job.contentReady
                        ? "Conversation text is ready; work-stream update failed: "
                        : "Sync could not finish: "}
                      {status.job.error}
                    </span>
                    <button onClick={() => void sync()}>Retry</button>
                  </div>
                )}
              <SyncWarnings
                job={status?.job}
                namingPending={!!status?.analysis.namingPending}
                onRetry={() =>
                  void api("analysis/name", {})
                    .then(() => refreshJob())
                    .catch((e) => setError(e.message))
                }
              />
              <div className="date-toolbar">
                <div>
                  <CalendarDays size={14} />
                  <span>Date</span>
                  <Select
                    w={180}
                    aria-label="Date range"
                    value={period}
                    onChange={(value) => value && setPeriod(value)}
                    data={[
                      { value: "week", label: "This week" },
                      { value: "today", label: "Today" },
                      { value: "7days", label: "Last 7 days" },
                      { value: "month", label: "This month" },
                      { value: "all", label: "All time" },
                      { value: "custom", label: "Custom dates" },
                    ]}
                  />
                  {period === "custom" && (
                    <div className="custom-dates">
                      <TextInput
                        type="date"
                        aria-label="Start date"
                        value={customStart}
                        onChange={(e) => setCustomStart(e.target.value)}
                      />
                      <span>to</span>
                      <TextInput
                        type="date"
                        aria-label="End date"
                        value={customEnd}
                        min={customStart}
                        onChange={(e) => setCustomEnd(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              </div>
              {range.error && (
                <div className="alert error" role="alert">
                  {range.error}
                </div>
              )}
              {!rangeInvalid && (
                <WorkOverview
                  scope={scope}
                  query={scopedQuery}
                  period={periodLabel}
                  indexing={busy || searching}
                  onFocus={(cluster) => {
                    setActiveCluster(cluster);
                    requestAnimationFrame(() =>
                      document.querySelector(".map-panel")?.scrollIntoView({
                        behavior: window.matchMedia(
                          "(prefers-reduced-motion: reduce)",
                        ).matches
                          ? "instant"
                          : "smooth",
                        block: "start",
                      }),
                    );
                  }}
                  onWorkItem={setDetail}
                  onSource={(id) => setDetail({ kind: "source", id })}
                />
              )}
              <section className="search-section">
                <form onSubmit={search}>
                  <Search size={20} />
                  <input
                    ref={input}
                    aria-label="Search your conversations"
                    placeholder="Ask about your work…"
                    value={query}
                    maxLength={4000}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <kbd>⌘ K</kbd>
                  <Button
                    variant="filled"
                    aria-label={searching ? "Searching" : "Search"}
                    disabled={searching || !query.trim() || rangeInvalid}
                    type="submit"
                  >
                    {searching ? (
                      <Loader2 size={15} className="spin" />
                    ) : (
                      <ArrowRight size={16} />
                    )}
                    <span>{searching ? "Searching…" : "Search"}</span>
                  </Button>
                </form>
                <div className="search-options">
                  <SegmentedControl
                    aria-label="Search mode"
                    value={mode}
                    onChange={setMode}
                    data={[
                      { value: "agent", label: "Agent" },
                      { value: "normal", label: "Semantic" },
                      { value: "hyde", label: "HyDE" },
                    ]}
                  />
                  <span className="mode-explanation">
                    {mode === "agent"
                      ? aiSummary
                        ? "Investigate across conversations, then answer with evidence."
                        : "Investigate across conversations and collect supporting context."
                      : mode === "hyde"
                        ? aiSummary
                          ? "Imagine an answer, then find the conversations behind it."
                          : "HyDE still uses AI for retrieval; no summary is generated."
                        : "Find meaning, beyond matching words."}
                  </span>
                  <Switch
                    label="AI summary"
                    labelPosition="left"
                    checked={aiSummary}
                    onChange={(event) =>
                      setAiSummary(event.currentTarget.checked)
                    }
                    ml="auto"
                  />
                </div>
              </section>
              <section className="map-panel">
                <div className="panel-header">
                  <div>
                    <span className="section-icon">
                      <Network size={16} />
                    </span>
                    <h2>Map</h2>
                  </div>
                  <div className="atlas-map-options">
                    {status?.analysis.mapPending && (
                      <Button
                        variant="default"
                        size="xs"
                        disabled={busy || syncing}
                        onClick={() => {
                          setSyncing(true);
                          void api("map/refresh", {})
                            .then(() => refreshJob())
                            .catch((e) => setError(e.message))
                            .finally(() => setSyncing(false));
                        }}
                        title="Place new sessions while preserving existing positions, work streams and task links."
                      >
                        Refresh map
                      </Button>
                    )}
                    {activeCluster !== null && (
                      <button
                        className="active-topic-filter"
                        onClick={() => setActiveCluster(null)}
                      >
                        {mapTopics.find((t) => t.cluster === activeCluster)
                          ?.title ||
                          topicLabels[activeCluster] ||
                          "Selected workstream"}
                        <X size={12} />
                      </button>
                    )}
                    <SegmentedControl
                      aria-label="Map view"
                      value={regionsMode ? "regions" : "points"}
                      onChange={(value) => setRegionsMode(value === "regions")}
                      data={[
                        { value: "points", label: "Points" },
                        { value: "regions", label: "Regions" },
                      ]}
                    />
                    <Checkbox
                      label="Fade older"
                      checked={fadeOlder}
                      onChange={(event) =>
                        setFadeOlder(event.currentTarget.checked)
                      }
                    />
                  </div>
                </div>
                {status?.analysis.stale && (
                  <div className="analysis-notice" role="status">
                    {status.analysis.version
                      ? "Showing the saved topic analysis. Sync sessions to include newer conversations."
                      : "Sync sessions to analyse and name your topics."}
                  </div>
                )}
                <EmbeddingMap
                  points={points}
                  project=""
                  fadeOlder={fadeOlder}
                  regionsMode={regionsMode}
                  emptyMessage={
                    stats?.excerpts === 0 && !busy
                      ? "Try another date range or sync to pick up new sessions."
                      : undefined
                  }
                  activeCluster={activeCluster}
                  highlighted={highlights}
                  onSelect={(id) => void openPoint(id)}
                />
                {mapTopics.length > 0 && (
                  <div
                    className="map-topic-legend"
                    aria-label="Work stream colours"
                  >
                    {mapTopics
                      .filter((topic) =>
                        points.some((point) => point.cluster === topic.cluster),
                      )
                      .map((topic) => (
                        <button
                          key={topic.cluster}
                          aria-pressed={activeCluster === topic.cluster}
                          onClick={() =>
                            setActiveCluster(
                              activeCluster === topic.cluster
                                ? null
                                : topic.cluster,
                            )
                          }
                        >
                          <i style={{ background: topic.color }} />
                          {topic.title}
                        </button>
                      ))}
                  </div>
                )}
              </section>
              {searchRequest && (
                <SearchAnswer
                  request={searchRequest}
                  onBusy={setSearching}
                  onSources={setSearchIds}
                  onSource={(id) => setDetail({ kind: "source", id })}
                  onClear={clearSearch}
                />
              )}
            </>
          )}
        </div>
      </main>
      {detail?.kind === "source" ? (
        <SourceDetails id={detail.id} onClose={() => setDetail(null)} />
      ) : (
        detail && (
          <TopicOverview
            selection={detail}
            scope={
              detail.kind === "stream" && detail.scope ? detail.scope : scope
            }
            onClose={() => setDetail(null)}
            onRenamed={() => void refresh()}
          />
        )
      )}
      <Modal
        opened={settings}
        onClose={() => setSettings(false)}
        title={settingsGuide ? "First-time setup" : "Settings & models"}
        size={600}
        closeButtonProps={{ "aria-label": "Close settings" }}
      >
        {settingsGuide ? (
          <FirstTimeSetup
            connected={status?.ollama.connected}
            onSettings={() => setSettingsGuide(false)}
            onMcp={() => {
              setSettings(false);
              navigate("mcp");
            }}
          />
        ) : (
          <>
            <Button
              variant="default"
              leftSection={<CircleHelp size={15} />}
              mb="lg"
              onClick={openSetupGuide}
            >
              First-time setup guide
            </Button>
            <AppearanceControls />
            {draft && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <Stack gap="md">
                  <Text fw={600} size="sm">
                    Session sources
                  </Text>
                  <TextInput
                    label="Claude sessions directory"
                    value={draft.source}
                    onChange={(e) =>
                      setDraft({ ...draft, source: e.currentTarget.value })
                    }
                  />
                  <TextInput
                    label="Codex sessions directory"
                    description="Includes archived sessions. Leave blank to use Claude only."
                    value={draft.codexSource}
                    placeholder="~/.codex/sessions"
                    onChange={(e) =>
                      setDraft({ ...draft, codexSource: e.currentTarget.value })
                    }
                  />
                  <Text fw={600} size="sm" mt="xs">
                    Local models
                  </Text>
                  <Autocomplete
                    label="Embedding model"
                    description="Changing this model re-embeds the index at the next sync."
                    value={draft.embeddingModel}
                    data={status?.ollama.models.map((m) => m.name) || []}
                    onChange={(value) =>
                      setDraft({ ...draft, embeddingModel: value })
                    }
                  />
                  <Autocomplete
                    label="Search & summary model"
                    description="Choose an installed instruction model, or enter its name."
                    value={draft.generationModel}
                    data={status?.ollama.models.map((m) => m.name) || []}
                    onChange={(value) =>
                      setDraft({ ...draft, generationModel: value })
                    }
                  />
                  {settingsError && (
                    <div className="alert error" role="alert">
                      {settingsError}
                    </div>
                  )}
                  {busy && (
                    <Text size="sm" c="dimmed">
                      Indexing is running. Wait for it to finish or pause it
                      before saving model or source changes.
                    </Text>
                  )}
                </Stack>
                <div className="atlas-settings-actions">
                  <Button
                    type="button"
                    variant="default"
                    onClick={() => setSettings(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="filled"
                    loading={saving}
                    disabled={busy}
                  >
                    Save settings
                  </Button>
                </div>
                <div className="hardware-info">
                  <Cpu size={14} />
                  {status?.hardware.chip} · {status?.hardware.memory} GB memory
                </div>
              </form>
            )}
          </>
        )}
      </Modal>
      <Modal
        opened={help}
        onClose={() => setHelp(false)}
        title="How Atlas works"
        size={620}
        closeButtonProps={{ "aria-label": "Close help" }}
      >
        <div className="atlas-help">
          <p>
            Atlas turns your Claude and Codex sessions into a searchable library
            of context.
          </p>
          <Button
            variant="default"
            leftSection={<CircleHelp size={15} />}
            onClick={openSetupGuide}
          >
            First-time setup guide
          </Button>
          <div className="help-step">
            <span>01</span>
            <div>
              <b>Make a little space</b>
              <p>
                Sync reads your session JSONL files and embeds conversation text
                with Ollama. It skips thinking blocks, tool output and subagent
                traces. Sync again to pick up changes.
              </p>
            </div>
          </div>
          <div className="help-step">
            <span>02</span>
            <div>
              <b>See the connections</b>
              <p>
                Today, Explore and summaries share the same saved work streams.
                The cloud shows a sample of conversation passages; nearby points
                suggest similar subjects, and colours show their work streams.
                Search covers the full index, including passages outside the
                map.
              </p>
            </div>
          </div>
          <div className="help-step">
            <span>03</span>
            <div>
              <b>Find it your way</b>
              <p>
                Semantic search embeds your question directly. HyDE writes a
                hypothetical answer locally, then retrieves similar real
                excerpts. The hypothetical passage is never copied as source
                material.
              </p>
            </div>
          </div>
          <div className="help-step">
            <span>04</span>
            <div>
              <b>See what’s taking shape</b>
              <p>
                Choose a date range; This week means Monday through today in
                your local timezone. Summarise work collects decisions,
                questions and agreed next steps within your saved work streams.
                Follow the source links to check details. Each overview stays
                tied to its exact date selection.
              </p>
            </div>
          </div>
          <div className="help-step">
            <span>05</span>
            <div>
              <b>Take the good bits with you</b>
              <p>
                Ask a question to get a streamed answer grounded in relevant
                conversations. Context is selected automatically, including
                surrounding replies. Copy the answer with its source references
                or follow a citation to check a detail.
              </p>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
function localDay(offset: number) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
