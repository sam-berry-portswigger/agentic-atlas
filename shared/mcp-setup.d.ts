export type AssistantClient =
  "claude-desktop" | "claude-code" | "codex" | "chatgpt";
export type McpLaunch = {
  command: string;
  args: string[];
  env: Record<string, string>;
};
export const assistantClients: { id: AssistantClient; label: string }[];
export const firstAtlasQuestion: string;
export function assistantSetup(
  launch: McpLaunch,
  projects: string[] | null,
  client: AssistantClient,
  desktopConfigPath: string,
): {
  config: string;
  command: string;
  prompt: string;
  label: string;
  skill: { name: string; content: string; defaultRule: string } | null;
};
