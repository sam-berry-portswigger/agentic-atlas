import {
  ActionIcon,
  Anchor,
  Button,
  CopyButton,
  Group,
  Stack,
  Text,
} from "@mantine/core";
import { ArrowUpRight, Check, Copy } from "lucide-react";

function Command({ value }: { value: string }) {
  return (
    <div className="atlas-setup-command">
      <code>{value}</code>
      <CopyButton value={value} timeout={2000}>
        {({ copied, copy }) => (
          <ActionIcon
            variant="subtle"
            aria-label={copied ? "Command copied" : `Copy ${value}`}
            title={copied ? "Copied" : "Copy command"}
            onClick={copy}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </ActionIcon>
        )}
      </CopyButton>
    </div>
  );
}

export default function FirstTimeSetup({
  connected,
  onSettings,
  onMcp,
}: {
  connected?: boolean;
  onSettings: () => void;
  onMcp: () => void;
}) {
  return (
    <Stack className="atlas-setup-guide" gap="lg">
      <Text size="sm" c="dimmed">
        Set up local models, choose your session folders, then sync your
        conversations.
      </Text>
      <ol>
        <li>
          <div>
            <h3>Start Ollama</h3>
            <p>
              <Anchor
                href="https://ollama.com/download"
                target="_blank"
                rel="noopener noreferrer"
                size="sm"
              >
                Install Ollama
              </Anchor>{" "}
              and open it. Keep it running while you use Atlas. If you prefer to
              start it in Terminal:
            </p>
            <Command value="ollama serve" />
            {connected !== undefined && (
              <Text size="xs" c="dimmed" mt={6}>
                {connected
                  ? "Ollama is connected to Atlas."
                  : "Atlas has not connected to Ollama yet. Open Ollama, then return to Settings."}
              </Text>
            )}
          </div>
        </li>
        <li>
          <div>
            <h3>Download two local models</h3>
            <p>
              Run these in Terminal, one at a time. The first powers search and
              grouping; the second writes answers and summaries.
            </p>
            <Command value="ollama pull embeddinggemma" />
            <Command value="ollama pull qwen3:4b" />
            <p>
              Already have local models? You can keep your installed pair
              instead.
            </p>
          </div>
        </li>
        <li>
          <div>
            <h3>Choose your sources and models</h3>
            <p>
              Back in Settings, keep the default session folders unless you
              store sessions elsewhere:
            </p>
            <ul>
              <li>
                Claude: <code>~/.claude/projects</code>
              </li>
              <li>
                Codex: <code>~/.codex/sessions</code>
              </li>
            </ul>
            <p>
              Leave the Codex folder blank to use Claude only. Choose{" "}
              <code>embeddinggemma</code> as the Embedding model and{" "}
              <code>qwen3:4b</code> as the Search &amp; summary model, or select
              your installed models. Then save.
            </p>
          </div>
        </li>
        <li>
          <div>
            <h3>Sync your conversations</h3>
            <p>
              Today checks for changes automatically. You can also click{" "}
              <b>Sync sessions</b> to start or resume. The first sync may take a
              while; progress appears on the page. Once it finishes, explore
              your work streams or search your conversations.
            </p>
          </div>
        </li>
        <li>
          <div>
            <h3>Prepare the map</h3>
            <p>
              With Python 3.11–3.14 installed, run this once from the Atlas
              project folder to prepare the local map worker:
            </p>
            <Command value="npm run setup:projection" />
            <p>
              In Explore, choose <b>Refresh map</b> to lay out your
              conversations. Today and search work without this step. Refreshing
              the map updates positions while keeping work streams and manual
              corrections.
            </p>
          </div>
        </li>
      </ol>
      <div className="atlas-setup-optional">
        <Text size="sm" fw={600}>
          Optional: connect your assistant
        </Text>
        <Text size="sm" c="dimmed" mt={4}>
          Open MCP, choose Setup, then follow the connection instructions for
          your assistant. You can use Atlas in the browser without this step.
        </Text>
        <Button
          variant="subtle"
          size="compact-sm"
          rightSection={<ArrowUpRight size={13} />}
          mt="xs"
          onClick={onMcp}
        >
          Open MCP
        </Button>
      </div>
      <Group justify="space-between">
        <Anchor
          href="https://docs.ollama.com/quickstart"
          target="_blank"
          rel="noopener noreferrer"
          size="xs"
        >
          Ollama documentation
        </Anchor>
        <Button onClick={onSettings}>Back to settings</Button>
      </Group>
    </Stack>
  );
}
