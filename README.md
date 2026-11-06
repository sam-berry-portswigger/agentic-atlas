# Atlas

A tool I use to promote parallel work while reducing cognitive load and maximising visibility and ownership.

Atlas brings Claude Code and Codex sessions into one local workspace. See what your agents are doing, keep related conversations together, and track shared tasks without switching between chats.

- **Today:** follow active sessions, work streams, and a shared task board. New tasks use the workstreams shown in Explore’s selected date range; existing task links remain available outside that range.
- **Explore:** search past conversations, inspect their connections, and read summaries with links to the evidence.
- **Connect your assistants:** use MCP to retrieve past context and update the same task board.

Session archives, the search index, and model inference stay on your Mac. Source conversations are read only. If you connect a cloud-backed assistant, any excerpts it retrieves enter that assistant’s context.

Atlas can check GitHub for updates in the background and show a local change overview before you choose to update. [Update behaviour and controls](docs/setup.md#app-updates).

## Get started

Requires macOS, Node.js 22.13+ (24+ recommended), [Ollama](https://ollama.com), and Python 3.11–3.14 for the map.

Start Ollama, then run:

```sh
npm install
ollama pull embeddinggemma
ollama pull qwen3:4b
npm run setup:projection
npm run dev
```

Open [localhost:5173](http://127.0.0.1:5173). In **Settings & models**, select your session folders and installed models, then choose **Sync sessions**. Select **qwen3:4b** as the instruction model if you downloaded it above.

The in-app **First-time setup guide** walks through each step. Use **Explore → Refresh map** to generate the map after syncing.

## More detail

- [Setup, configuration, and local data](docs/setup.md)
- [Using Today, tasks, and Explore](docs/usage.md)
- [Connect Claude Code, Codex, or another MCP client](docs/mcp.md)
- [Architecture, retrieval, and evidence](docs/architecture.md)
- [Contributing](AGENTS.md)

For development checks, run `npm test`, `npm run build`, and `npm run format:check`.
