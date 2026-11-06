import {
  Alert,
  Button,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";

export default function SessionRename({
  session,
  kind = "session",
  analysisVersion,
  scope,
  onClose,
  onSaved,
}: {
  session: { id: string; title: string };
  kind?: "session" | "workstream";
  analysisVersion?: string;
  scope?: { project: string; start: string; end: string };
  onClose: () => void;
  onSaved: (title: string) => void;
}) {
  const label = kind === "session" ? "session" : "work stream";
  const base = kind === "session" ? "today/sessions" : "workstreams";
  const identity =
    kind === "session"
      ? { session: session.id }
      : {
          streamId: Number(session.id),
          analysisVersion,
          scope,
          previousTitle: session.title,
        };
  const [title, setTitle] = useState(session.title);
  const [suggestion, setSuggestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const edits = useRef(0);
  const request = useRef<AbortController | null>(null);
  async function suggest(force = false) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const edit = edits.current;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/${base}/suggest-title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...identity, force }),
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || "Couldn’t suggest a name.");
      if (controller.signal.aborted) return;
      setSuggestion(result.title);
      if (edits.current === edit) setTitle(result.title);
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    request.current?.abort();
    setTitle(session.title);
    setSuggestion("");
    setLoading(false);
    setError("");
    edits.current = 0;
    return () => request.current?.abort();
  }, [session.id, kind, analysisVersion]);
  return (
    <Modal
      opened
      onClose={() => {
        if (!saving) onClose();
      }}
      title={kind === "session" ? "Rename session" : "Rename work stream"}
      centered
      size="md"
      closeOnEscape={!saving}
      closeOnClickOutside={!saving}
      closeButtonProps={{
        "aria-label": "Close rename dialog",
        disabled: saving,
      }}
    >
      <Stack
        component="form"
        aria-label={`Rename ${label}`}
        gap="sm"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim() || title.trim() === session.title || saving) return;
          setSaving(true);
          setError("");
          try {
            const result = await api<{ title: string }>(`${base}/rename`, {
              ...identity,
              title,
            });
            onSaved(result.title);
          } catch (e) {
            setError((e as Error).message);
            setSaving(false);
          }
        }}
      >
        <TextInput
          autoFocus
          data-autofocus
          label={kind === "session" ? "Session name" : "Work stream name"}
          value={title}
          maxLength={80}
          disabled={saving}
          onChange={(e) => {
            edits.current++;
            setTitle(e.currentTarget.value);
          }}
        />
        <Text size="xs" c="dimmed" role="status">
          {loading
            ? "Suggesting a name with local AI…"
            : kind === "workstream" && suggestion === session.title
              ? "The current name still fits this work stream. You can edit it or suggest again."
              : suggestion
                ? "Review or edit the name, then save it in Atlas."
                : "Enter a name, or ask local AI for a suggestion."}
        </Text>
        {suggestion && suggestion !== title && (
          <Button
            variant="subtle"
            h="auto"
            styles={{ label: { whiteSpace: "normal", textAlign: "left" } }}
            disabled={saving}
            onClick={() => {
              edits.current++;
              setTitle(suggestion);
            }}
          >
            Use suggestion: {suggestion}
          </Button>
        )}
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="space-between" gap="sm">
          <Button
            variant="default"
            loading={loading}
            disabled={saving}
            leftSection={<Sparkles size={14} />}
            onClick={() => void suggest(!!suggestion)}
          >
            {suggestion ? "Suggest again" : "Suggest name"}
          </Button>
          <Group gap="xs" ml="auto">
            <Button variant="default" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={saving}
              disabled={!title.trim() || title.trim() === session.title}
            >
              Save name
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
