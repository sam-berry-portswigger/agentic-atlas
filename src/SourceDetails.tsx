import { Drawer, Loader, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { api, formatDate, type Excerpt } from "./api";
import Markdown from "./Markdown.js";

// Reading evidence must work before a passage has a saved stream assignment.
export default function SourceDetails({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const [source, setSource] = useState<Excerpt | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setSource(null);
    setError("");
    void api<{ results: Excerpt[] }>("excerpts", { ids: [id] })
      .then(({ results }) => {
        if (!live) return;
        if (results[0]) setSource(results[0]);
        else setError("This passage is no longer available in the index.");
      })
      .catch((error: Error) => {
        if (live) setError(error.message);
      });
    return () => {
      live = false;
    };
  }, [id]);
  return (
    <Drawer
      opened
      onClose={onClose}
      size={650}
      title="Conversation source"
      closeButtonProps={{ "aria-label": "Close source" }}
      classNames={{ body: "atlas-source-details" }}
    >
      {!source && !error && (
        <div role="status" className="atlas-drawer-label">
          <Loader size="sm" /> Loading passage…
        </div>
      )}
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {source && (
        <>
          <h2>{source.title || "Conversation passage"}</h2>
          <Text size="sm" c="dimmed" mb="md">
            {source.project || "No project"} · {formatDate(source.timestamp)} ·{" "}
            {new Date(source.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </Text>
          <Text size="sm" fw={600} mb="sm">
            {source.role === "user" ? "User message" : "Assistant response"}
          </Text>
          <Markdown>{source.text}</Markdown>
        </>
      )}
    </Drawer>
  );
}
