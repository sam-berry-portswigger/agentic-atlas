import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Skeleton,
  Stack,
  Text,
} from "@mantine/core";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { readNDJSON } from "../shared/stream.js";

export default function SessionBrief({
  session,
  onClose,
}: {
  session: { id: string; title: string };
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [asOf, setAsOf] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setText("");
    setError("");
    setAsOf("");
    setLoading(true);
    void (async () => {
      const response = await fetch("/api/today/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: session.id, stream: true }),
        signal: controller.signal,
      });
      if (!response.ok)
        throw Error(
          (await response.json()).error || "Couldn’t prepare the TLDR.",
        );
      if (!response.body) throw Error("The summary stream is unavailable.");
      let done = false;
      await readNDJSON(
        response.body,
        (message: {
          event: string;
          text?: string;
          summary?: string;
          asOf?: string;
          error?: string;
        }) => {
          if (controller.signal.aborted) return;
          if (message.event === "error") throw Error(message.error);
          if (message.event === "summary")
            flushSync(() => setText(message.text || ""));
          if (message.event === "done") {
            done = true;
            setText(message.summary || "");
            setAsOf(message.asOf || "");
            setLoading(false);
          }
        },
      );
      if (!done && !controller.signal.aborted)
        throw Error("The summary stopped before finishing. Please retry.");
    })().catch((e: Error) => {
      if (!controller.signal.aborted) {
        setError(e.message);
        setLoading(false);
      }
    });
    return () => controller.abort();
  }, [session.id, retry]);
  return (
    <Stack
      component="section"
      aria-label="Session TLDR"
      aria-busy={loading}
      gap="sm"
      mt="md"
      mb="lg"
    >
      <Group justify="space-between">
        <Text size="sm" fw={600}>
          TLDR
        </Text>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label="Close session TLDR"
          onClick={onClose}
        >
          <X size={15} />
        </ActionIcon>
      </Group>
      {error ? (
        <Alert color="red" title="Couldn’t prepare the TLDR">
          {error}
          <Button variant="subtle" onClick={() => setRetry((n) => n + 1)}>
            Retry
          </Button>
        </Alert>
      ) : text ? (
        <Text size="sm" style={{ whiteSpace: "pre-wrap", lineHeight: 1.7 }}>
          {text}
        </Text>
      ) : (
        <Stack gap={8} role="status" aria-label="Preparing session TLDR">
          <Skeleton height={12} />
          <Skeleton height={12} />
          <Skeleton height={12} width="65%" />
        </Stack>
      )}
      <Text size="xs" c="dimmed">
        {loading
          ? text
            ? "Generating…"
            : "Preparing TLDR…"
          : asOf
            ? `As of ${new Date(asOf).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`
            : ""}
      </Text>
    </Stack>
  );
}
