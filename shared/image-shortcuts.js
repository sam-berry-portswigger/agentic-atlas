/** Keep browser undo in an active text editor; classify image history shortcuts elsewhere. */
export function imageHistoryShortcut(event) {
  if (event.defaultPrevented || event.isComposing || event.altKey) return null;
  if (!event.metaKey && !event.ctrlKey) return null;
  const target = event.target;
  if (
    target?.isContentEditable ||
    target?.closest?.(
      "input, textarea, [contenteditable='true'], [contenteditable='']",
    )
  )
    return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && event.ctrlKey && !event.metaKey) return "redo";
  return null;
}
