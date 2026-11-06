# Setup and local data

[Back to Atlas](../README.md)

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

## App updates

Atlas checks the configured GitHub origin’s default branch at startup and every six hours using your existing Git credentials. An update notice appears below Settings; review the locally generated overview and expandable commit list before choosing **Update now**, **Skip this version**, or **Don’t remind me again**. Re-enable checks in Settings & models.

Updates fast-forward a clean checkout on its default branch. Local edits, divergent history, active indexing, and dependency changes block the action with an explanation. Updates never install packages or overwrite local changes. If dependencies changed, update and install them from the terminal. Restart Atlas after updating; production installs also need `npm run build`. Your ignored `.atlas/` data stays in place. Set `ATLAS_UPDATE_CHECKS=0` to suppress scheduled checks for test or offline runs.

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
