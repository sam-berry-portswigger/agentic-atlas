import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  Menu,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { Download, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { appliedUpdate } from "../shared/app-update-result.js";
import "./AppUpdates.css";

type UpdateState = {
  enabled: boolean;
  currentSha: string | null;
  targetSha: string | null;
  branch: string | null;
  behind: number;
  ahead: number;
  commits: { sha: string; subject: string }[];
  summary: string | null;
  summarySource: "commits" | "local" | null;
  available: boolean;
  checking: boolean;
  applying: boolean;
  lastChecked: number | null;
  error: string | null;
  canUpdate: boolean;
  blockedReason: string | null;
  restartRequired: boolean;
  updatedVersion: string | null;
  dependenciesChanged: boolean;
  skippedVersion: string | null;
};
async function requestUpdate(route = "", body?: unknown) {
  const response = await fetch(`/api/updates${route ? "/" + route : ""}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(route ? 90000 : 5000),
  });
  const next = (await response.json()) as UpdateState;
  if (!response.ok)
    throw Error(next.error || "Couldn’t reach Atlas update status.");
  return next;
}
export function useAppUpdates() {
  const [data, setData] = useState<UpdateState | null>(null);
  const [open, setOpen] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const operationRef = useRef<string | null>(null);
  useEffect(() => {
    let disposed = false;
    async function refresh() {
      if (document.hidden || operationRef.current) return;
      const revision = epoch.current;
      try {
        const next = await requestUpdate();
        if (!disposed && revision === epoch.current && !operationRef.current)
          setData(next);
      } catch {
        /* Routine availability failures stay quiet; Check now retries. */
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), open ? 3000 : 60000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [open]);
  async function act(route: string, body: unknown = {}) {
    if (operationRef.current) return false;
    operationRef.current = route;
    epoch.current++;
    setOperation(route);
    setError("");
    try {
      const next = await requestUpdate(route, body);
      setData(next);
      if (next.error) {
        setError(next.error);
        return false;
      }
      return true;
    } catch (e) {
      if (route === "apply") {
        const expected = (body as { expectedSha?: string }).expectedSha;
        // Watch mode can restart the server before the merge response arrives.
        for (let i = 0; i < 8; i++) {
          await new Promise((resolve) => setTimeout(resolve, 750));
          try {
            const next = await requestUpdate();
            if (appliedUpdate(next, expected)) {
              setData(next);
              return true;
            }
          } catch {
            /* Allow the local server a short restart window. */
          }
        }
        setError(
          "Atlas lost the update connection. Check status before trying again; the server may still be restarting.",
        );
      } else
        setError(
          (e as Error).message || "Couldn’t check for updates. Try again.",
        );
      return false;
    } finally {
      operationRef.current = null;
      setOperation(null);
      epoch.current++;
    }
  }
  return {
    data,
    open,
    setOpen,
    pending: operation !== null,
    operation,
    error,
    act,
  };
}
type Controller = ReturnType<typeof useAppUpdates>;
export function UpdateSidebar({
  controller,
  compact = false,
}: {
  controller: Controller;
  compact?: boolean;
}) {
  if (!controller.data?.available || !controller.data.enabled) return null;
  return (
    <button
      className="atlas-update-nav"
      onClick={() => controller.setOpen(true)}
      aria-label="Atlas update available"
    >
      <Download size={compact ? 14 : 17} />
      {!compact && <span>Update available</span>}
      <span className="atlas-update-dot" aria-hidden="true" />
    </button>
  );
}
export function UpdatePreferences({
  controller: c,
}: {
  controller: Controller;
}) {
  return (
    <section className="atlas-update-preferences" aria-label="App updates">
      <Text fw={600} size="sm" mb="sm">
        App updates
      </Text>
      <Switch
        label="Check GitHub for updates"
        description="Checks at startup and every six hours. Updates require your approval."
        checked={c.data?.enabled ?? true}
        disabled={!c.data || c.pending || c.data.applying}
        onChange={(e) =>
          void c.act("preferences", { enabled: e.currentTarget.checked })
        }
      />
      <Group gap="sm" mt="sm">
        <Button
          variant="default"
          size="xs"
          loading={c.operation === "check" || c.data?.checking}
          disabled={c.pending || c.data?.applying}
          leftSection={<RefreshCw size={13} />}
          onClick={() => void c.act("check")}
        >
          Check now
        </Button>
        {c.data?.available && (
          <Button variant="subtle" size="xs" onClick={() => c.setOpen(true)}>
            Review update
          </Button>
        )}
        {c.data?.lastChecked && (
          <Text size="xs" c="dimmed">
            {c.data.error ? "Last attempt" : "Last checked"}{" "}
            {new Date(c.data.lastChecked).toLocaleString()}
          </Text>
        )}
      </Group>
      {(c.error || c.data?.error) && (
        <Text c="red" size="xs" role="alert" mt="xs">
          {c.error || c.data?.error}
        </Text>
      )}
      {!c.pending && !c.data?.checking && !c.error && !c.data?.error && (
        <Text size="xs" c="dimmed" mt="xs">
          {!c.data
            ? "Update status hasn’t loaded. Use Check now to retry."
            : !c.data.enabled
              ? "Automatic checks are off."
              : c.data.restartRequired
                ? "Update downloaded. Restart Atlas to load it."
                : c.data.behind > 0 &&
                    c.data.skippedVersion === c.data.targetSha
                  ? "This version is skipped. You’ll hear about the next one."
                  : c.data.lastChecked && c.data.behind === 0
                    ? "You’re up to date."
                    : !c.data.lastChecked
                      ? "Atlas checks when it starts, then every six hours."
                      : null}
        </Text>
      )}
    </section>
  );
}
export function UpdateDialog({ controller: c }: { controller: Controller }) {
  const d = c.data;
  const applying = c.operation === "apply" || !!d?.applying;
  const complete =
    !!d?.restartRequired ||
    !!(
      d?.updatedVersion &&
      d.updatedVersion === d.currentSha &&
      !d.available &&
      d.behind === 0
    );
  return (
    <Modal
      opened={c.open}
      onClose={() => {
        if (!applying) c.setOpen(false);
      }}
      title="Update Atlas"
      size={600}
      zIndex={320}
      closeOnEscape={!applying}
      closeOnClickOutside={!applying}
      closeButtonProps={{
        "aria-label": "Close update",
        disabled: applying,
      }}
    >
      <Stack gap="md">
        {complete ? (
          <Alert
            color="green"
            title={d?.restartRequired ? "Update downloaded" : "Atlas updated"}
          >
            {d?.restartRequired
              ? "Restart Atlas to load the new version. For a production install, run npm run build first."
              : "The server restarted successfully with the update. Reload this page to load the updated interface."}
          </Alert>
        ) : (
          <>
            <Group gap="xs">
              <Badge variant="light">{d?.branch || "Default branch"}</Badge>
              <Text size="sm" c="dimmed">
                {d?.behind || 0} new {d?.behind === 1 ? "commit" : "commits"}
              </Text>
            </Group>
            <div>
              <Text size="xs" fw={600} c="dimmed" mb={6}>
                {d?.summarySource === "local" ? "What’s changed" : "Changes"}
              </Text>
              {d?.summary &&
                (d.summarySource === "local" || !d.commits.length) && (
                  <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                    {d.summary}
                  </Text>
                )}
              {d?.summarySource === "local" && (
                <Text size="xs" c="dimmed" mt="xs">
                  AI summary generated locally from commit titles.
                </Text>
              )}
              {!!d?.commits.length && (
                <details
                  className="atlas-update-details"
                  open={d.summarySource !== "local"}
                >
                  <summary>
                    View {d.commits.length}{" "}
                    {d.commits.length === 1 ? "commit" : "commits"}
                    {d.behind > d.commits.length ? ` of ${d.behind}` : ""}
                  </summary>
                  <ul className="atlas-update-commits">
                    {d.commits.map((commit) => (
                      <li key={commit.sha}>
                        <span>{commit.subject}</span>
                        <code>{commit.sha.slice(0, 7)}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            <Text size="xs" c="dimmed">
              Your tasks and settings stay in place. Restart Atlas after
              updating. Production installs also need npm run build.
            </Text>
            {d?.blockedReason && d.behind > 0 && (
              <Alert color="yellow" title="Before updating">
                {d.blockedReason}
              </Alert>
            )}
          </>
        )}
        {(c.error || d?.error) && (
          <Alert color="red" role="alert">
            {c.error || d?.error}
          </Alert>
        )}
        {complete ? (
          <Group justify="flex-end">
            <Button variant="default" onClick={() => c.setOpen(false)}>
              Close
            </Button>
            {!d?.restartRequired && (
              <Button onClick={() => location.reload()}>Reload Atlas</Button>
            )}
          </Group>
        ) : (
          <>
            <Group justify="space-between" gap="sm">
              <Menu position="bottom-start" withinPortal zIndex={330}>
                <Menu.Target>
                  <Button variant="subtle" color="gray" disabled={c.pending}>
                    More options
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item
                    disabled={!d?.targetSha || !d.behind}
                    onClick={() => {
                      void c
                        .act("preferences", { skipVersion: d?.targetSha })
                        .then((ok) => {
                          if (ok) c.setOpen(false);
                        });
                    }}
                  >
                    Skip this version
                  </Menu.Item>
                  <Menu.Item
                    onClick={() => {
                      void c
                        .act("preferences", { enabled: false })
                        .then((ok) => {
                          if (ok) c.setOpen(false);
                        });
                    }}
                  >
                    Don’t remind me again
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
              <Group gap="xs" ml="auto">
                {(!d?.canUpdate || c.error || d.error) && (
                  <Button
                    variant="default"
                    loading={c.operation === "check"}
                    disabled={applying}
                    onClick={() => void c.act("check")}
                  >
                    Check again
                  </Button>
                )}
                <Button
                  variant="default"
                  disabled={c.pending}
                  onClick={() => c.setOpen(false)}
                >
                  Later
                </Button>
                <Button
                  leftSection={<Download size={15} />}
                  loading={applying}
                  disabled={
                    c.pending || !d?.canUpdate || !d.targetSha || !d.available
                  }
                  onClick={() =>
                    void c.act("apply", { expectedSha: d?.targetSha })
                  }
                >
                  Update now
                </Button>
              </Group>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
}
