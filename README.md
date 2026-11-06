# Atlas

A private React workspace for exploring and retrieving context from Claude Code and Codex sessions. Includes a colourful semantic map, normal semantic and HyDE retrieval, and streamed, source-grounded answers you can copy with references.

## Today: work streams and shared tasks

The default **Today** view shows Claude and Codex activity on your browser's local calendar day. **Explore** retains the archive map, search and work summaries; direct links support `?view=today` and `?view=explore`.

Today shows **work streams → conversations**. Local density clusters are the saved work streams, with one name and set of conversation cards each. Disconnected map neighbourhoods are not merged into broad historical categories. A short naming prompt synthesises the concrete subject from bounded opening and recent dialogue, with displayed session names as supporting clues. It returns a name, a factual scope sentence and an incidental-activity flag, without requiring a goal or completion claim. Naming cannot split, merge or move conversations. Names are cached and remain stable during routine sync; an explicit naming refresh uses current evidence and reuses unchanged cached results. Clustering saved positions preserves source text, embeddings, conversation identities, map coordinates and tasks. Date and project filters select conversations while retaining the saved workstream name across Today, Explore, details and shared tasks. Reads do not generate new names. Naming refreshes prefer general, enduring names and retain the existing name unless its scope no longer fits. Explore uses the same saved clusters and names, with Points / Regions changing only the presentation.

Linked session families expand on demand. Sessions, families and streams can be archived and restored. Active sessions show a green status dot; turn completion remains separate from task completion.

Forks and shared-history branches in the same saved work stream fold into one display family by default. The broken-chain **Detach chat** control shows a branch and its delegated children separately; **Reattach chat** folds it back. This browser-facing grouping preserves original provenance, independent native statuses and indexed evidence. Read/unread and archive controls follow the displayed family boundaries.

While Today is visible, Atlas checks for changed session files every 30 seconds and catches up when you return. Only new or changed text needs embedding; changed conversations reuse saved topic names and cached representations. Routine sync reuses the saved work-stream assignments and names. Newly combined clusters receive a cached topic-naming pass; unchanged clusters need no generation. Names do not automatically evolve on every message. Routine sync does no map projection. Concurrent tabs share one bounded queue, failures back off, and Pause remains paused across restarts until you choose Sync sessions. Activity discovery still refreshes separately every 3 seconds.

Sync progress reports committed counts, elapsed time and completed stages. Model waits use an indeterminate indicator, and optional naming failures preserve successfully imported sessions. Progress polls the lightweight `/api/jobs` endpoint; heavyweight metadata is refreshed on catalogue changes. Existing map positions remain available while layout is pending; **Refresh map** in Explore updates the layout separately from Today.

Sync status lives beside **Sync sessions** in the page header. Its icon indicates activity; opening it shows current progress or the last completed stage breakdown in a popover without moving the page.

The session's three-dot menu includes Rename session. The configured local model suggests a general name using a stable random sample across the whole conversation, with its opening and latest user requests included. Edit or retry it before saving. Saved names appear throughout Atlas and survive catalogue rebuilds. Source conversation titles and messages stay untouched.

Shared controls use Mantine with one Atlas theme. In light mode, content surfaces are white with neutral borders and dark text; subtle tinted headers and small accents provide colour. Status filters use a segmented control, boards use flat tabs, and tasks open read-only in a modal with an explicit Edit action. Session links use a searchable multiselect backed by metadata-only archive lookup.

**Settings & models → Appearance** offers Light, Dark or System mode and Sage, Lavender or Blue accents. Preferences persist in the current browser and apply to Today, Explore, dialogs, menus and the map's background/labels. Topic colours remain unchanged.

Activity discovery reads configured source roots independently of the excerpt importer. It reads Codex's sibling `state_5.sqlite` for titles/relationships when present and native Claude subagent directories and live process metadata. It does not import tool transcripts into search or modify source sessions. Claude discovery requires a user message today; Codex metadata can also include recent activity where a user event is unavailable, disclosed in session details. Today's indexed user messages fill gaps in sampled logs. Internal guardian reviews are omitted. Files over 6 MB are sampled from the beginning and end and marked in details. Native file formats can change; status is best effort. The interface shows activity without input-needed alerts. Unverified activity is shown explicitly; finished turns display as Idle, since they do not mean the user’s work is complete. Unread is separate: it marks a reply not yet opened in Atlas.

The shared **To do / In progress / Done** board lives in the same Atlas SQLite database, independent of analysis rebuilds. Tasks hold notes, an optional project and up to 20 session links. Click a task to edit, use its status dropdown, or drag it between columns. Every update requires the current revision; conflicting edits are rejected for reconciliation. Retired workstream links reconnect automatically only when every conversation in their last saved membership now belongs to one substantive current workstream. Ambiguous splits retain the historical board; similar names alone never merge work. Reconciliation preserves stored task revisions, content and provenance. Workstream IDs are never recycled, and map refreshes retain established names for matching groups. The board remains available through MCP when the browser is closed. Existing MCP clients must reconnect to discover the new tools:

- `atlas_tasks`: read accessible tasks and revisions.
- `atlas_create_task`: create a task with `title`, optional `notes`, `status`, `project` and `sessions`.
- `atlas_update_task`: send `id`, current `revision` and changed fields.
- `atlas_report_session`: report `session`, `provider`, `status`, optional `title`, `project` and a known `parent`. Codex IDs start with `codex:`. Send a heartbeat every 60 seconds while running; reports expire after 3 minutes. Reporting a completed turn never changes task completion.

Existing MCP project restrictions apply to tasks, linked sessions and reports. Scoped clients must supply an allowed task project; unassigned tasks are accessible to unrestricted clients. **MCP → Setup** provides one connection setup prompt for the selected app. The setup prompt connects MCP and installs or updates an Atlas skill for default task tracking and adaptive search, together with a short persistent instruction to load it. Claude Code and Codex use user-level skill and instruction files; Claude Desktop chat requires installing and enabling the skill through Customize → Skills. Existing Atlas skills are reused, and access restrictions and unrelated settings are preserved. Setup reports connection, skill installation and persistent instructions separately; a prepared file alone does not establish that the target client loaded it. Clients may need to reconnect or start a new chat. Default task tracking and search behavior should be checked during real work.

The web API uses `GET /api/today?start=ISO&end=ISO` (a local-day interval, maximum 27 hours), and JSON POST routes `/api/today/tasks/list`, `/tasks/create`, `/tasks/update`, `/session` and `/layout`. Layout is stored by session ID. Discovery refreshes every 3 seconds while the view is visible; no continuous graph simulation runs after settling. Shared tables are `today_tasks`, `today_events` and `today_layout`.

## Run

For a short in-app walkthrough, open **Settings & models → First-time setup guide**, or use the same link in Help. It covers starting Ollama, downloading local models, choosing session folders and models, the first sync, and the optional MCP connection. Commands can be copied individually; returning to Settings preserves unsaved edits.

Requires **Node.js 22.13+**, macOS, and [Ollama](https://ollama.com). Node 24+ is recommended for its built-in SQLite support. Map refresh uses a local Python 3.11–3.14 worker with scikit-learn. There is no persistent Python service, Docker requirement, cloud inference, or API key.

```sh
npm install
npm run setup:projection       # create the local map runtime once
ollama serve                    # skip if Ollama is already running
ollama pull embeddinggemma
npm run dev
```

The setup command installs pinned projection dependencies into the ignored `.atlas/projection-venv/` directory. `ATLAS_PYTHON` selects the Python used for setup; `ATLAS_PROJECTION_PYTHON` can select an existing environment containing `requirements-projection.txt`. Session sync, embeddings and search remain independent of this runtime.

Open **http://127.0.0.1:5173**. Today starts a change check automatically; **Sync sessions** also starts or resumes an update. The default sources are `~/.claude/projects/` and `~/.codex/sessions/` (plus Codex’s sibling `archived_sessions/` folder). Configure both in Settings & models; leave the Codex path blank to disable it. Missing Codex folders are skipped. First sync imports and embeds the archive and creates the saved topic catalogue; optional naming failures retain safe assignments and a warning. Later syncs update only affected conversation representations and reuse saved names. Search is available as soon as embeddings commit. Map layout is separate: use **Refresh map** in Explore when its layout is pending.

In **Settings & models**, choose an installed instruction model for HyDE and summaries. This workspace defaults to `gemma4:12b-mlx`, which was already installed on the target Mac. On a different machine, choose your own model or download a smaller one:

```sh
ollama pull qwen3:4b
```

Model names are editable and local installed models are suggested. Both selected models must be installed in Ollama. Changing the embedding model requires another sync; Atlas excludes vectors from other models until re-embedded.

For a production build:

```sh
npm run build
npm start
```

Then open **http://127.0.0.1:4317**. Both servers bind to loopback only.

## How it works

- **Import:** streams top-level session `.jsonl` files; keeps user and assistant text; excludes thinking blocks, tool calls/results, metadata messages, sidechains, and nested subagent traces. Invalid/partial JSONL lines are skipped. Session titles and project names come from session metadata. Claude source files are read only.
- **Chunking:** bounded 1,800-character excerpts with 200-character overlap. Stable content IDs preserve cached vectors when a session grows. Updated and deleted files are reconciled on the next sync.
- **Embedding:** local Ollama `/api/embed`, batched in groups of 24. Normalized float32 vectors and excerpts are persisted in SQLite with WAL in `.atlas/`, excluded from version control. The importer, embedder, and projection run in a worker thread so the UI remains responsive.
- **Retrieval:** browser Semantic/HyDE/Agent search, MCP search and follow-ups share a relevance-and-relative-recency policy. Relevant matches receive a bounded age weighting of up to 18%, with a 30-day half-life measured from the newest evidence inside the selected scope. Project/date restrictions apply before ranking; missing dates gain no freshness credit, and older strong matches remain available. Raw cosine similarity is still returned separately from the combined rank score. Context selection, bulk overview sampling, topic summaries and work ordering use the shared freshness calculation. Clustering and map positions continue to represent semantic structure.
- **Agent search (default):** retrieves the original question, then asks the local model which evidence is missing. It runs focused semantic/keyword follow-ups in parallel and reassesses the evidence before answering the original question. The agent keeps an evidence-backed findings ledger, can read original passages and adjacent replies, and checks candidate obligations for later decisions, cancellations and replacement approaches. It reassesses after each fetch, verifies each candidate against later entity-specific mentions, and finishes with cross-finding reconciliation so dependencies of retired work are not left open. Decisive citations receive reserved context ahead of general matches; older evidence cannot overwrite a newer verified decision, and unchecked open claims become unknown. Verified scope changes are retained as cited verbatim excerpts, and free-form answer paragraphs about that retired work are replaced by the original decision rather than reopening it. The same guard applies to work-item questions. At most ten queries, twelve source reads, four tool rounds plus a final assessment, and 75 seconds of retrieval/reasoning; planning input is capped at 16,000 characters and final answer context at 28,000 (24,000 for work questions). Related thread endings and later outcomes get reserved context. Progress streams, Stop cancels active work, and a completed search exposes the queries it used. A bounded investigation cannot guarantee exhaustive coverage; when it reaches its budget the answer is told to acknowledge material gaps. If planning fails, one deterministic outcome search is attempted instead of inventing evidence. Work-item questions use the same investigation loop. MCP remains an evidence API for its calling agent; its retrieval receives the same recency bias without extra local generation calls.

- **HyDE:** the local generation model writes a hypothetical answer; that passage is embedded as a document to retrieve real excerpts. The original question always retains its own retrieval pass; a hypothetical passage cannot replace it. The hypothetical passage is only a retrieval aid. The final answer always responds to your original question using real conversations; generated hypotheses never enter its evidence.
- **Analysis and map:** A versioned topic catalogue uses conversation-wide vectors and evidence-backed naming. Original passage embeddings remain the source of truth for search. HDBSCAN density leaves identify local neighbourhoods on the saved UMAP map. Broad semantic categories do not merge these leaves. This lets all-time data retain many distinct local groups while shorter windows show their visible subsets. Filtering does not rerun UMAP or move points. Names and descriptions are published from workstream dialogue and remain consistent across filtered views. Routine coordination, interrupted brief requests, connection checks and probes can stay in the quiet sessions area without becoming promoted work streams. Meaningful implementation or research is retained regardless of its title. Opening a window reads saved names without generation; sync and explicit naming refreshes use bounded local batches. The map plots the original saved conversation positions, capped at 1,800. Refresh map updates positions and their density clusters together; date/project filters preserve saved coordinates, and search highlights a conversation for any matching passage. Regions and point colours use the same named work streams as Today.

- **Answers:** turn **AI summary** off for retrieval only: matching conversations are highlighted on the map, source links remain available and **Copy context** copies the automatically selected context. Semantic retrieval makes no generation calls; HyDE generates its retrieval hypothesis and Agent uses the local model to plan searches. Search checks and imports changed sessions before retrieval, with cancellation and progress. With **AI summary** on, search automatically synthesizes selected conversation context, including surrounding requests and replies. The answer streams inline below the map with progress and a Stop control. There is no excerpt grid, manual selection, or recent-excerpt view. Context is bounded to 28,000 characters including metadata, uses whole passages and respects the current project/date filters. Answers cite numbered sources you can inspect on demand. Copy answer includes the synthesis and source references; partial/stopped responses are never presented as completed answers.

- **Topic and work summaries:** start automatically when a topic/work panel opens and stream as Markdown. The input contains at most 16 whole passages and 12,000 characters including metadata, selected for relevance, recency and substantive outcomes, with defining work evidence retained and fork duplicates removed. Only completed summaries are cached, keyed by all supporting content, topic title, model and selection policy. They survive analysis rebuilds when that content is unchanged; added, edited or removed supporting passages invalidate the cache. Related conversations are collapsed by default; numbered citations (including groups such as `[1, 2, 10]`) open the corresponding supporting passage. Search answers, work overviews and conversation evidence share the same Markdown renderer.

## Apple Silicon

The default 300M-parameter [EmbeddingGemma](https://ollama.com/library/embeddinggemma) model is about 622 MB. Ollama handles local hardware acceleration; installed MLX generation models can be selected directly. A compact quantized model such as [Qwen3 4B](https://ollama.com/library/qwen3:4b) is an alternative if you prefer a smaller memory footprint. Atlas disables reasoning output for short HyDE/summary tasks, uses a 12K context for search answers and a bounded 16K context for work overviews, limits batches to 24, and bounds map computation to avoid unnecessary memory pressure. Actual speed depends on your chip, RAM, model, and other running workloads.

## Local data and configuration

The app uses no remote fonts, analytics, CDN assets, or model APIs. Ollama is restricted to loopback hosts, and the backend rejects remote Host/Origin headers. Downloading dependencies or models requires internet access during setup. The index is a local copy of your conversation text; protect it as you would the source archive. SQLite files are stored under a directory created with owner-only permissions.

Optional environment variables:

| Variable         | Default                  | Purpose                                                                                |
| ---------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| `PORT`           | `4317`                   | Backend/production port; changing it also requires updating the Vite development proxy |
| `ATLAS_DATA_DIR` | `.atlas`                 | Local SQLite index directory                                                           |
| `OLLAMA_URL`     | `http://127.0.0.1:11434` | Local Ollama endpoint; non-loopback hosts are rejected                                 |

Settings persist inside the index database. The `.atlas/atlas.sqlite` database also stores the shared task board and saved session positions. Back it up before removing `.atlas/` to rebuild the index; source sessions are never modified. Sync sessions updates the map and retrieval index. Work overview generation also refreshes changed sessions automatically before reading its evidence.

## Verify

```sh
npm test
npm run build
```

Tests use isolated temporary data and a local mock inference server. They cover filtering thinking/tool content, partial JSONL records, stable IDs, chunk overlap, import, embedding, UMAP output, normal/HyDE retrieval, source-linked summaries, unchanged-file caching, appended messages, origin protection, chronological conversation windows, later cross-session outcomes, validated quotations, conservative unresolved status, malformed model output recovery, and automatic overview index refresh. They do not contact a cloud model or read your real sessions.

## Work overview and dates

The date filter defaults to **This week** (Monday through today in your browser's local timezone). Choose Today, Last 7 days, This month, All time, or inclusive custom dates. Calendar boundaries account for daylight saving. The same range and project filter apply to semantic/HyDE retrieval, map points, recent excerpts, and work summaries; sidebar statistics reflect the selected dates across projects. A session spanning several dates contributes only the excerpts written within the range. Undated excerpts appear under All time only. Selected clipboard context is intentionally retained when filters change.

Click **Summarise work** for a compact work overview with a top-level summary and **In focus** items. Generation refreshes changed session files, then makes one local model call across the selected work. For an all-project overview, projects need at least six distinct substantive messages, including two user and two assistant turns, and 2,000 characters of discussion (each message contributes at most 2,000). Chunks of one message and duplicate fork content do not inflate this threshold. A single sustained session can qualify; explicitly selecting a project bypasses the threshold. Small setup/reporting sessions remain searchable. A shared budget of 40,000 characters selects original passages across projects and distinct user requests, keeping a project’s investigation, engine work and UI migration together, favoring recent outcomes and avoiding repeated fork content. Neighboring requests/replies are retained where they fit; passages are never cut to meet the budget. Related research, implementation and testing threads are merged into project-level focus items; independent objectives within a large repository can remain separate. Session titles are omitted from the model input; context selection reads original requests and covers early intent, recent requests and differing tasks within a session. Numbered evidence references are validated and mapped back to original excerpts. This targets a sub-minute refresh with the existing generation model; actual time depends on archive changes, model load, hardware and inference speed.

Each focus item has one **Ask a question** action that opens a question popup. Enter any question or choose **What’s unresolved?** inside the popup. These run **only when requested**: the local index is refreshed, semantic and keyword retrieval reads original related conversations and later outcomes through the selected end date, and the local model answers with source links. This deeper retrieval gets its own 24,000-character budget. Outcomes are labelled open, resolved, superseded or unclear, with validated supporting quotations. Assistant caveats and permission-to-commit questions are excluded from confirmed open work. Missing replies do not prove completion. No task extraction, unresolved-work check, or workstream report is pre-run for the overview.

The overview retains its top-level summary and compact In focus layout, with multiple named source links beneath each item. It has no status column or report-card grid. Copy copies the summary, focus items and selected period. Named links open an overview of that specific work item, preserving the link title and every supporting source. Related discussion and follow-ups are selected in bulk from those sources and concrete work references, then saved as work-item membership. Opening the panel only filters that saved membership by project/date; it never searches for or infers new members. A work item can span several topics, so its link is neutral unless it belongs to a single topic. The optional local AI summary uses the same focused evidence and is cached against the analysis version, filters and generation model. Map points still open broader topic overviews. Cached focus items remain readable when new sessions arrive, with a refresh notice. Questions and answers stay separate from the overview cache. The model can miss or misinterpret evidence; conversation history cannot prove changes made elsewhere.

Overview generation runs in a worker. Pause discards an in-flight overview and preserves the last completed one. Caches are isolated by date/project scope and marked stale when indexed evidence, projection or models change. Overview generation, questions, indexing and configuration changes are serialized to avoid conflicting snapshots or concurrent model pressure. Models that reject schema enforcement (including some MLX runners) fall back to JSON prompting; malformed JSON receives one bounded retry.

Question responses stream from Ollama through the local API as newline-delimited JSON. The popup shows actual indexing/retrieval stages and the selected dated excerpts, then animates answer text as tokens arrive. Findings appear when each complete finding has passed source/quotation validation; final citations are checked before completion. Stop, Escape and closing the popup cancel the client request and its local model worker. Reduced-motion preferences disable reveal animations.

## MCP: use Atlas from another assistant

Open **MCP** in Atlas’s sidebar (or the plug button on a narrow screen) and choose **Setup** for session retrieval options, copyable installation prompts, manual configuration and a first question. Setup prompts are intended for Claude Code or Codex with local file access; the guide explains the additional connection requirements for ChatGPT. Atlas displays a setup prompt; the assistant that receives it configures the connection, installs the skill and adds the default-use instruction. Atlas itself does not edit another client’s configuration.

Atlas includes an independent **local stdio MCP server**. Your assistant retrieves original conversations and performs its own synthesis. The server never calls a local generation model, writes an overview, or infers whether work is complete. The browser and Express server do not need to be running.

For a client that uses `mcpServers` JSON configuration, copy the `atlas` entry from [mcp.example.json](mcp.example.json) into the client's MCP configuration. The supplied example uses this Mac's Node installation and Atlas checkout and retrieves from all indexed sessions by default, including projects added later. Choose **Only selected projects** in the guide to restrict which projects' sessions an assistant can retrieve. Sessions without explicit project information remain included by default; Atlas assigns folder-based fallback labels to them. Change the executable and script paths for another installation; use an **absolute Node path** if the client does not inherit your shell's PATH. Restart/reconnect the MCP client after configuration.

```json
{
  "mcpServers": {
    "atlas": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/agentic-atlas/server/mcp.js"]
    }
  }
}
```

Client configuration formats differ. The underlying launch command is `node /absolute/path/to/agentic-atlas/server/mcp.js`, using **stdio** transport. You can also run `npm run --silent mcp` from the repository. This is a protocol process, so waiting silently for JSON-RPC input is expected. Stdout contains protocol messages only; diagnostics go to stderr.

The default database is this installation's `.atlas/atlas.sqlite`, even when a client launches the process from a different working directory. To use another index, set an absolute `ATLAS_DATA_DIR`. The configured source directory and embedding model come from that same index's settings. Nothing changes the MCP client's working directory.

| Tool                   | What it returns                                                                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atlas_status`         | Permitted projects, date coverage, excerpt/session/embedding counts and archive freshness.                                                                                                                       |
| `atlas_search`         | Semantic, keyword or hybrid search with original excerpts, source IDs, dates and speakers. Optional `hypothesis` lets the calling model provide HyDE text.                                                       |
| `atlas_read_context`   | Chronological neighboring conversation for up to eight excerpt IDs, with `offset` / `nextOffset` pagination within the requested window.                                                                         |
| `atlas_activity`       | Balanced original requests and replies across a period, discussion sizes, included projects and coverage limitations. Uses the same project/context selection as the browser overview, without generating prose. |
| `atlas_find_followups` | Related evidence and later outcomes for cited work, through an explicit cutoff. The assistant assesses what that evidence establishes.                                                                           |
| `atlas_sync`           | Explicitly refreshes changed sessions and pending embeddings, reporting actual worker progress. Source sessions are read only; map projection is skipped.                                                        |

Search, activity, context and follow-up tools accept `project`, inclusive `start` and exclusive `end` ISO timestamps. Relative dates should be resolved in the owner's timezone by the caller. Context expansion strictly respects those bounds; widen the date range explicitly to inspect older or later conversation. Session labels remain available for navigation, with instructions to infer work from the message bodies.

Evidence tools accept a `budget` between 4,000 and 60,000 characters. The budget counts serialized source objects; metadata is additional. Whole excerpts are retained, with returned/omitted counts and coverage information. Search also exposes the number of ranked matches and `moreAvailable`. Activity is intentionally sampled: follow up with search and context expansion rather than treating it as an exhaustive list. Context pagination traverses the selected neighboring window; increase `before` / `after` or choose another anchor to read farther. A result with `needsLargerBudget` requires a higher budget rather than another page request.

Each source has a stable ID and an MCP resource URI, `atlas://excerpt/{id}`, which the client can read directly for the original passage. Resources enforce the same project restrictions as tools. Similarity is raw cosine similarity, not confidence; `rankScore` combines relevance (including reciprocal-rank fusion in hybrid mode) with relative recency. Keyword search works without Ollama; semantic search, HyDE and follow-up ranking need the configured local embedding model. Activity and context make no inference calls. Unchanged syncs reuse embeddings.

Optional MCP environment settings:

| Variable             | Default                       | Purpose                                                                                                                         |
| -------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ATLAS_MCP_PROJECTS` | Unset: all indexed projects   | JSON array of exact permitted project names. `[]` exposes no projects. Applies to metadata, tools and direct excerpt resources. |
| `ATLAS_MCP_SYNC`     | Enabled                       | Set to `0` to disable index updates from the MCP client.                                                                        |
| `ATLAS_DATA_DIR`     | This installation's `.atlas/` | Absolute path to a different Atlas index directory.                                                                             |
| `OLLAMA_URL`         | `http://127.0.0.1:11434`      | Local embedding service; loopback addresses only, as in the web app.                                                            |

`atlas_sync` checks the **whole configured local archive**, reuses unchanged embeddings, and updates affected conversation assignments unless `analyse=false`; map layout is separate. Project restrictions govern the data returned to the assistant. MCP retrieval reports freshness and does not silently start indexing; Today's automatic updates are coordinated by the local web application. An index-writer lock is shared with browser indexing; concurrent updates return a busy error. Cancelled syncs abort an in-flight embedding request and release the writer. A dead process's stale lock is recovered on the next update; an abandoned worker heartbeat expires after 30 seconds.

The index and embeddings stay local. **Excerpts returned to a cloud-backed assistant enter that assistant's context.** Use the project allowlist to choose what that client may retrieve. Archived prompts, pasted content and instructions are evidence only. The server exposes no shell execution, arbitrary filesystem reads, configuration editing, source deletion, or cloud model connection.

Try asking the connected assistant:

- “Use Atlas to summarise my substantive work this week. Follow up on each major item and cite the original conversations.”
- “What decisions did I make about sign-in cancellation, and did later sessions change the plan?”
- “Reconstruct the brain imaging project, including its engine investigation and React migration.”
- “What appears unresolved? Search for later outcomes before calling anything open; distinguish uncertainty from agreed tasks.”

The MCP integration test launches a real stdio client/server pair from a different working directory against an isolated archive and mock embedding server. It checks all tools, resources, date cutoffs, paging, bounded output, project-denied reads, disabled sync, progress, cancellation and incremental indexing. It asserts that **no generation endpoint is called**. Existing web integration tests also exercise the shared retrieval service.

### Monitoring MCP usage

Open **MCP → Activity** for a live call history across connected assistants: tool, client, scope, search mode, elapsed time, evidence volume, result JSON size, omissions and errors/cancellations. Expand a call for details; switch between the last 24 hours and 7 days. Successful-call median and p95 timings measure Atlas processing, not the assistant’s reasoning. Payload sizes measure the result JSON, not protocol overhead or billed tokens. More evidence available is a coverage signal, not an error.

Metadata is stored in the shared local index, capped at the latest 1,000 calls. Queries, hypotheses, excerpt contents and raw errors are never logged. The list shows the latest 100 calls in the chosen period; totals cover all retained calls in that period. Only dispatched tool calls and excerpt resource reads are recorded, not protocol validation failures or discovery requests. Reconnect existing MCP clients after updating Atlas to enable recording. This works even while the web UI is closed.

Codex import reads user and assistant text from rollout message records. Reasoning, encrypted blocks, tools, system/developer messages, environment scaffolding and spawned subagent rollouts are excluded. Conversation IDs are namespaced to keep Claude and Codex sources distinct. Unchanged files retain their existing embeddings.

Analysis tables (`analysis_runs`, `analysis_topics`, `analysis_members`, `analysis_conversations`, `analysis_work`, and `analysis_work_members`) are the source of truth for topic and work navigation. Original chunks and embeddings remain the source of truth for search. Search and MCP evidence-only imports journal affected sessions for the next incremental catalogue update. The first incremental update preserves the full base snapshot; subsequent updates atomically modify one live incremental version, with separate assignment/map revision timestamps so open panels keep valid IDs without accumulating archive-sized snapshots. A persisted text-document frequency index preserves corpus-wide duplicate downweighting when only changed representations are computed. Existing map coordinates are retained and marked pending when necessary; new conversations have no invented location before Refresh map. Topic/work panel reads do not call a model or change membership. Work overview generation remains an explicit optional summary operation.

A naming plan’s validated source assignments take precedence over whole-conversation similarity for the conversations it explicitly cites. Conflicting source claims remain uncertain. Corrective rebuilds can repair those reviewed assignments while retaining unsampled established work and manual corrections. This separates source ownership from geometric similarity; it does not guarantee that a local model has interpreted the evidence correctly.

### Map projection

Explore uses deterministic cosine UMAP settings (15 neighbours, minimum distance 0.08, negative sample rate 30, seed 42) to position the saved conversation vectors. **Refresh map** updates coordinates and publishes the matching local density clusters together. An existing cluster keeps its identity, name and colour when its full membership continues together and supplies at least half of the new group. Splits retire the old identity rather than silently giving one branch its task board. Manual corrections are preserved, and new clusters are named from their own evidence. Dates filter conversations within those saved clusters without changing their names or running another projection. Unchanged naming evidence is reused from the cache. Refresh is cancellable; dependency errors, invalid output and cancellation preserve the previous saved map. New sessions can move older points when the complete map is refreshed.
