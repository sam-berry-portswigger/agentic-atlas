import { Alert, Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";

export default function SessionRename({
  session,
  onClose,
  onSaved,
}: {
  session: { id: string; title: string };
  onClose: () => void;
  onSaved: (title: string) => void;
}) {
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
      const response = await fetch("/api/today/sessions/suggest-title", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: session.id, force }),
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
    void suggest();
    return () => request.current?.abort();
  }, [session.id]);
  return (
    <Stack
      component="form"
      aria-label="Rename session"
      gap="sm"
      mt="md"
      mb="lg"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim() || title.trim() === session.title || saving) return;
        setSaving(true);
        setError("");
        try {
          const result = await api<{ title: string }>("today/sessions/rename", {
            session: session.id,
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
        label="Session name"
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
          : "Review or edit the name, then save it in Atlas."}
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
      <Group gap="xs">
        <Button
          type="submit"
          loading={saving}
          disabled={!title.trim() || title.trim() === session.title}
        >
          Save name
        </Button>
        <Button
          variant="default"
          loading={loading}
          disabled={saving}
          leftSection={<Sparkles size={14} />}
          onClick={() => void suggest(true)}
        >
          Suggest again
        </Button>
        <Button variant="default" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
      </Group>
    </Stack>
  );
}
