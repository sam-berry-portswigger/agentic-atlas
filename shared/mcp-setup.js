// These are copyable instructions only. Atlas never edits another app's config.
export const assistantClients = [
  { id: "claude-desktop", label: "Claude Desktop" },
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "chatgpt", label: "ChatGPT" },
];
export const firstAtlasQuestion =
  "Use Atlas to summarise my substantive work this week. Group related work across sessions, check later outcomes before calling anything unresolved, and cite the original conversations.";
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
export function assistantSetup(launch, projects, client, desktopConfigPath) {
  const env = { ...launch.env };
  delete env.ATLAS_MCP_PROJECTS;
  if (projects !== null) env.ATLAS_MCP_PROJECTS = JSON.stringify(projects);
  const entry = { command: launch.command, args: launch.args, env };
  const json = JSON.stringify({ mcpServers: { atlas: entry } }, null, 2);
  const cli =
    client === "claude-code"
      ? `claude mcp add-json atlas ${shellQuote(JSON.stringify({ ...entry, type: "stdio" }))} --scope user`
      : client === "codex"
        ? `codex mcp add atlas ${Object.entries(entry.env)
            .map(([key, value]) => `--env ${shellQuote(`${key}=${value}`)}`)
            .join(
              " ",
            )} -- ${[entry.command, ...entry.args].map(shellQuote).join(" ")}`
        : "";
  const config =
    client === "codex"
      ? `[mcp_servers.atlas]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n\n[mcp_servers.atlas.env]\n${Object.entries(
          entry.env,
        )
          .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
          .join("\n")}`
      : json;
  const label =
    assistantClients.find((option) => option.id === client)?.label ||
    "your assistant";
  const retrievalScope =
    projects === null
      ? "Retrieve sessions from the entire Atlas index, including sessions without a named project and projects indexed later. Do not add a project restriction. Remove any previous ATLAS_MCP_PROJECTS value from this Atlas connection's configuration."
      : `Retrieve sessions only from these projects: ${JSON.stringify(projects)}. Keep this exact allowlist.`;
  const base = `Atlas is already installed on this Mac and has a local stdio MCP server. Use the existing server and index; no new server or text-generation model is needed.\n\n${retrievalScope} Retrieved excerpts may enter the connected model's context.\n\n`;
  if (client === "chatgpt")
    return {
      config,
      command: "",
      prompt: `Help me connect my existing Atlas MCP server to ChatGPT. ${base}Local launch configuration:\n${json}\n\nAtlas currently provides stdio only. Check which supported ChatGPT plugin or private/remote connection route is available for my account. Explain any additional packaging or transport needed; do not claim it is connected just because I pasted this brief. Do not create a public endpoint, deploy anything or start a tunnel without my explicit instruction. If direct ChatGPT setup is unavailable, explain how to use this server locally with Codex.`,
      label,
    };
  const installation =
    client === "claude-desktop"
      ? `Check Claude Desktop's existing Atlas connection, including desktop extensions. If it is already connected, reuse it. Otherwise merge the atlas entry below into ${desktopConfigPath}, backing up that file and preserving other settings. Do not add a second Atlas connection.\n\n${json}`
      : `Check the Atlas connection in ${label}. Update it if present; otherwise add it with this command. Preserve other settings and servers.\n\n${cli}\n\nConfiguration:\n${config}`;
  return {
    config,
    command: cli,
    label,
    prompt: `Connect or update Atlas in ${label} on this Mac. Use local configuration tools if available; otherwise give exact setup steps.\n\n${base}${installation}\n\nThis one connection includes search, work streams and shared tasks. Atlas supplies the board workflow through MCP server instructions; do not install a separate skill or rules entry. Keep existing access approvals.\n\nVerify the connection in ${label}, not just in the assistant performing this setup: check atlas_status and the available tools atlas_tasks, atlas_create_task, atlas_update_task, atlas_streams and atlas_report_session. Check that server instructions include the shared-board workflow where the client exposes them. Do not read session contents or create test tasks. If a restart or new chat is needed, say so and report verification as pending until ${label} reconnects. Do not claim proactive board use has been verified merely because the tools are available.`,
  };
}
