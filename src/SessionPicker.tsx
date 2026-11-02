import { Loader, MultiSelect } from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
export type SessionOption = {
  id: string;
  title: string;
  project: string;
  provider: "claude" | "codex";
  nativeId: string;
  hostSessionId?: string;
  parent?: string;
};
export default function SessionPicker({
  sessions,
  value,
  onChange,
}: {
  sessions: SessionOption[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [found, setFound] = useState<SessionOption[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const signature = JSON.stringify(value);
  useEffect(() => {
    if (!open && !value.length) return;
    let live = true;
    const timer = setTimeout(() => {
      setLoading(true);
      setError("");
      void api<{ sessions: SessionOption[] }>("today/sessions/search", {
        query,
        ids: value,
      })
        .then((result) => {
          if (live) {
            setFound(result.sessions);
            setLoading(false);
          }
        })
        .catch(() => {
          if (live) {
            setLoading(false);
            setError(
              "Archive search unavailable. Today's sessions remain available.",
            );
          }
        });
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, query, signature]);
  const options = useMemo(
    () => new Map([...found, ...sessions].map((s) => [s.id, s])),
    [sessions, found],
  );
  const data = [...options.values()].map((s) => ({
    value: s.id,
    label: s.title,
  }));
  for (const id of value)
    if (!options.has(id))
      data.push({ value: id, label: `Earlier session · ${id.slice(0, 12)}…` });
  return (
    <MultiSelect
      label="Linked sessions"
      description="Optional conversation shortcuts"
      placeholder="Search sessions…"
      searchable
      clearable
      maxValues={20}
      value={value}
      onChange={onChange}
      data={data}
      searchValue={query}
      onSearchChange={setQuery}
      onDropdownOpen={() => setOpen(true)}
      onDropdownClose={() => setOpen(false)}
      nothingFoundMessage={loading ? "Searching…" : "No matching sessions"}
      error={error || undefined}
      rightSection={loading ? <Loader size="xs" /> : undefined}
      clearButtonProps={{ "aria-label": "Clear linked sessions" }}
      comboboxProps={{
        withinPortal: true,
        middlewares: { flip: true, shift: true },
        shadow: "md",
      }}
      filter={({ options: items, search }) =>
        items
          .filter((item) => {
            if (!("value" in item)) return false;
            const session = options.get(String(item.value));
            return `${item.label} ${session?.project || ""} ${session?.provider || ""} ${item.value}`
              .toLowerCase()
              .includes(search.toLowerCase().trim());
          })
          .slice(0, 40)
      }
      renderOption={({ option }) => {
        const session = options.get(String(option.value));
        return (
          <div className="atlas-session-option">
            {option.label}
            <small>
              {session?.provider === "claude"
                ? "Claude"
                : session?.provider === "codex"
                  ? "Codex"
                  : "Earlier session"}
              {session?.project ? " · " + session.project : ""}
            </small>
          </div>
        );
      }}
    />
  );
}
