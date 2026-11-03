import { atlasSkill, atlasDefaultRule } from "./atlas-skill.js";

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
      skill: null,
    };
  const installation =
    client === "claude-desktop"
      ? `Check Claude Desktop's existing Atlas connection, including desktop extensions. If it is already connected, reuse it. Otherwise merge the atlas entry below into ${desktopConfigPath}, backing up that file and preserving other settings. Do not add a second Atlas connection.\n\n${json}`
      : `Check the Atlas connection in ${label}. Update it if present; otherwise add it with this command. Preserve other settings and servers.\n\n${cli}\n\nConfiguration:\n${config}`;
  const skill = {
    name: "atlas",
    content: atlasSkill(),
    defaultRule: atlasDefaultRule(),
  };
  const skillInstallation =
    client === "claude-desktop"
      ? "Install and enable the Atlas skill in Claude Desktop using its supported Customize > Skills route. Package the SKILL.md below inside an atlas folder in a ZIP for upload if needed. Reuse or update an existing Atlas/atlas-board skill instead of installing a duplicate. Local ~/.claude/skills files configure Claude Code; writing one alone does not install a Claude Desktop chat skill. Add the default-use instruction below to the target app's supported persistent instructions. If upload, enablement or persistent instructions require user interaction, prepare the exact artifact and steps and report that step as pending, not installed."
      : client === "claude-code"
        ? "Install the SKILL.md below as a user-level Claude Code skill at ~/.claude/skills/atlas/SKILL.md. First inspect existing atlas and atlas-board skills, following symlinks; reuse a matching existing skill, preserving its name and path, instead of creating a duplicate. Back up the existing file before updating it and preserve unrelated custom guidance. Merge the default-use instruction below into a marked Atlas section in ~/.claude/CLAUDE.md so it applies across projects; do not replace other instructions."
        : "Install the SKILL.md below as a user-level Codex skill in the skill location supported by this installation (normally ~/.agents/skills/atlas/SKILL.md; reuse an existing discovered Atlas skill, including a legacy ~/.codex/skills/atlas installation). Inspect and back up the existing skill before updating it; preserve unrelated custom guidance and avoid duplicates. Keep implicit invocation enabled. Merge the default-use instruction below into a marked Atlas section in the user's Codex home AGENTS.md, respecting CODEX_HOME, and preserve all other instructions.";
  const skillSetup = `${skillInstallation} Match the SKILL.md name and the default-use instruction to the reused skill name (atlas or atlas-board). Use <!-- atlas-workflow:start --> and <!-- atlas-workflow:end --> around the default-use instruction. Update only that marked section on repeated setup. Do not add tool preapprovals, hooks or background processes. The skill must retain the exact connection scope; it must not remove an allowlist or broaden permissions.\n\nSKILL.md contents:\n${skill.content}\nDefault-use instruction:\n${skill.defaultRule}`;
  return {
    config,
    command: cli,
    label,
    skill,
    prompt: `Connect or update Atlas in ${label} on this Mac. Use local configuration tools if available; otherwise give exact setup steps.\n\n${base}${installation}\n\nThis one connection includes search, work streams and shared tasks. Install or update the default-use skill as part of this setup, in addition to connecting MCP. Keep existing access approvals.\n\n${skillSetup}\n\nVerify the connection in ${label}, not just in the assistant performing this setup: check atlas_status and the available tools atlas_tasks, atlas_create_task, atlas_update_task, atlas_streams and atlas_report_session. Verify that the skill is discovered and enabled in the target client and the default-use instruction is loaded. Check that server instructions include task tracking and adaptive search where the client exposes them. Do not read session contents or create test tasks. If a restart or new chat is needed, say so and report verification as pending until ${label} reconnects. Report connection, skill installation and default-use instruction verification separately. Do not claim proactive board use or adaptive search has been verified merely because the tools or skill files exist. Observe those behaviors on the next real user-requested task; do not create artificial tasks or read private history for setup verification.`,
  };
}
