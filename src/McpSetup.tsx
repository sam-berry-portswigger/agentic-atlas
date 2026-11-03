import { SegmentedControl, Select, MultiSelect } from "@mantine/core";
import { Button } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Copy, Loader2 } from "lucide-react";
import { api } from "./api";
import {
  assistantClients,
  assistantSetup,
  type AssistantClient,
  type McpLaunch,
} from "../shared/mcp-setup.js";
import McpActivity from "./McpActivity";
type SetupInfo = {
  launch: McpLaunch;
  projects: { project: string; excerpts: number }[];
  defaultProjects: null;
  desktopConfigPath: string;
};
const docs = {
  "claude-desktop":
    "https://modelcontextprotocol.io/docs/develop/connect-local-servers",
  "claude-code": "https://code.claude.com/docs/en/mcp",
  codex: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
  chatgpt: "https://developers.openai.com/plugins/build/app-quickstart",
};
export default function McpSetup({
  project,
  initialView = "activity",
}: {
  project: string;
  initialView?: "activity" | "setup";
}) {
  const [view, setView] = useState<"activity" | "setup">(initialView),
    [data, setData] = useState<SetupInfo | null>(null),
    [error, setError] = useState("");
  const [client, setClient] = useState<AssistantClient>("claude-desktop"),
    [projects, setProjects] = useState<string[]>([]),
    [restricted, setRestricted] = useState(false),
    [copied, setCopied] = useState(""),
    [fallback, setFallback] = useState("");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let mounted = true;
    void api<SetupInfo>("mcp/setup")
      .then((next) => {
        if (mounted) {
          setData(next);
          setProjects(
            project && next.projects.some((p) => p.project === project)
              ? [project]
              : [],
          );
        }
      })
      .catch((e) => {
        if (mounted) setError(e.message);
      });
    return () => {
      mounted = false;
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);
  useEffect(() => {
    setCopied("");
    setFallback("");
  }, [client, projects, restricted]);
  const setup = data
    ? assistantSetup(
        data.launch,
        restricted ? projects : null,
        client,
        data.desktopConfigPath,
      )
    : null;
  const invalid = restricted && !projects.length;
  async function copy(text: string, name: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(name);
      setFallback("");
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(""), 2500);
    } catch {
      setFallback(text);
      setCopied("");
    }
  }
  return (
    <section className="mcp-page" aria-labelledby="mcp-title">
      <header className="page-heading">
        <div>
          <h1 id="mcp-title">MCP</h1>
          <p>Connect your assistants to Atlas.</p>
        </div>
      </header>
      <div className="mcp-body">
        <SegmentedControl
          value={view}
          onChange={setView}
          data={[
            { value: "activity", label: "Activity" },
            { value: "setup", label: "Setup" },
          ]}
          aria-label="MCP view"
          mb="lg"
        />
        {view === "activity" ? (
          <McpActivity onSetup={() => setView("setup")} />
        ) : (
          <section
            className="mcp-simple-setup"
            aria-labelledby="mcp-connect-title"
          >
            <h2 id="mcp-connect-title">Connect Atlas</h2>
            <p className="mcp-setup-hint">
              Choose the app to connect, then paste the setup prompt into an
              assistant with local file access.
            </p>
            <div className="mcp-setup-fields">
              <Select
                label="Platform"
                value={client}
                onChange={(value) => setClient(value as AssistantClient)}
                data={assistantClients.map((option) => ({
                  value: option.id,
                  label: option.label,
                }))}
              />
              <Select
                label="Session access"
                value={restricted ? "selected" : "all"}
                onChange={(value) => setRestricted(value === "selected")}
                data={[
                  { value: "all", label: "All indexed sessions" },
                  { value: "selected", label: "Selected projects" },
                ]}
              />
            </div>
            {restricted && data && (
              <MultiSelect
                label="Projects"
                description="Only selected projects will be available to this connection."
                placeholder="Search projects…"
                searchable
                clearable
                value={projects}
                onChange={setProjects}
                data={data.projects.map((p) => p.project)}
                nothingFoundMessage={
                  data.projects.length
                    ? "No matching projects"
                    : "Sync sessions to find projects"
                }
              />
            )}
            {!data && !error && (
              <p className="mcp-loading" role="status">
                <Loader2 size={15} className="spin" />
                Preparing setup…
              </p>
            )}
            {error && (
              <div className="alert error" role="alert">
                {error}
              </div>
            )}
            {data && setup && (
              <>
                {client === "chatgpt" && (
                  <p className="mcp-setup-note">
                    ChatGPT needs a compatible plugin or remote connection. This
                    copies a connection brief, not a direct installer.
                  </p>
                )}
                <div className="mcp-setup-actions">
                  <Button
                    variant="filled"
                    disabled={invalid}
                    onClick={() => void copy(setup.prompt, "prompt")}
                  >
                    {copied === "prompt" ? (
                      <Check size={15} />
                    ) : (
                      <Copy size={15} />
                    )}{" "}
                    {copied === "prompt"
                      ? "Copied"
                      : client === "chatgpt"
                        ? "Copy connection brief"
                        : "Copy setup prompt"}
                  </Button>
                </div>
                <p className="mcp-setup-hint" aria-live="polite">
                  {invalid
                    ? "Choose at least one project."
                    : client === "chatgpt"
                      ? "Search, work streams and shared tasks use the same connection."
                      : "Setup includes the Atlas skill for default task tracking and adaptive search."}
                </p>
                <details className="mcp-setup-advanced">
                  <summary>Advanced setup</summary>
                  <details className="mcp-details">
                    <summary>Preview setup prompt</summary>
                    <pre>{setup.prompt}</pre>
                  </details>
                  <details className="mcp-details">
                    <summary>Manual configuration</summary>
                    {client === "claude-desktop" ? (
                      <p>
                        Reuse an existing Atlas connection. For manual setup,
                        merge the Atlas entry into{" "}
                        <code>{data.desktopConfigPath}</code>, preserving other
                        settings, then restart Claude Desktop.
                      </p>
                    ) : client !== "chatgpt" ? (
                      <p>
                        Run this command to add Atlas. Update the existing entry
                        if it is already configured, then reconnect the client.
                      </p>
                    ) : (
                      <p>
                        Local stdio configuration requires compatible ChatGPT
                        packaging or transport.
                      </p>
                    )}
                    {setup.command && (
                      <div className="mcp-code">
                        <button
                          className="text-button"
                          disabled={invalid}
                          onClick={() => void copy(setup.command, "command")}
                        >
                          {copied === "command" ? "Copied" : "Copy command"}
                        </button>
                        <pre>{setup.command}</pre>
                      </div>
                    )}
                    <div className="mcp-code">
                      <button
                        className="text-button"
                        disabled={invalid}
                        onClick={() => void copy(setup.config, "config")}
                      >
                        {copied === "config" ? "Copied" : "Copy config"}
                      </button>
                      <pre>{setup.config}</pre>
                    </div>
                    {!restricted && (
                      <p>
                        Remove an existing ATLAS_MCP_PROJECTS restriction to
                        include all sessions.
                      </p>
                    )}
                    <a href={docs[client]} target="_blank" rel="noreferrer">
                      Official setup guide <ArrowUpRight size={12} />
                    </a>
                  </details>
                </details>
                {fallback && (
                  <div className="mcp-clipboard-fallback">
                    <label htmlFor="mcp-copy-text">
                      Clipboard unavailable. Select and copy:
                    </label>
                    <textarea
                      id="mcp-copy-text"
                      value={fallback}
                      readOnly
                      autoFocus
                      onFocus={(e) => e.currentTarget.select()}
                    />
                  </div>
                )}
                <p className="mcp-privacy">
                  Your index stays local. Retrieved content enters the connected
                  assistant’s context.
                </p>
              </>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
