# Connect an assistant

[Back to Atlas](../README.md)

## MCP: use Atlas from another assistant

Open **MCP** in Atlas’s sidebar (or the plug button on a narrow screen) and choose **Setup** for session retrieval options, copyable installation prompts, manual configuration and a first question. Setup prompts are intended for Claude Code or Codex with local file access; the guide explains the additional connection requirements for ChatGPT. Atlas displays a setup prompt; the assistant that receives it configures the connection, installs the skill and adds the default-use instruction. Atlas itself does not edit another client’s configuration.

Atlas includes an independent **local stdio MCP server**. Your assistant retrieves original conversations and performs its own synthesis. The server never calls a local generation model, writes an overview, or infers whether work is complete. The browser and Express server do not need to be running.

For a client that uses `mcpServers` JSON configuration, copy the `atlas` entry from [mcp.example.json](../mcp.example.json) into the client's MCP configuration. The supplied example uses this Mac's Node installation and Atlas checkout and retrieves from all indexed sessions by default, including projects added later. Choose **Only selected projects** in the guide to restrict which projects' sessions an assistant can retrieve. Sessions without explicit project information remain included by default; Atlas assigns folder-based fallback labels to them. Change the executable and script paths for another installation; use an **absolute Node path** if the client does not inherit your shell's PATH. Restart/reconnect the MCP client after configuration.

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
