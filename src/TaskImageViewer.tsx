import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Modal,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useMergedRef, useResizeObserver } from "@mantine/hooks";
import {
  Check,
  Highlighter,
  Pencil,
  Redo2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  arrowHead,
  imagePoint,
  markupHistory,
  wheelImageScale,
} from "../shared/image-markup.js";
import { imageHistoryShortcut } from "../shared/image-shortcuts.js";

type Point = [number, number];
type Tool = "view" | "pen" | "highlighter" | "arrow" | "rectangle" | "text";
type Mark = {
  tool: Exclude<Tool, "view">;
  points: Point[];
  color: string;
  text?: string;
};
export default function TaskImageViewer({
  src,
  name,
  onClose,
  onSave,
  draft = false,
}: {
  src: string;
  name: string;
  onClose: () => void;
  onSave?: (file: File) => Promise<void>;
  draft?: boolean;
}) {
  const [viewportRef, viewport] = useResizeObserver();
  const viewportElement = useRef<HTMLDivElement>(null);
  const setViewportRef = useMergedRef(viewportRef, viewportElement);
  const image = useRef<HTMLImageElement>(null);
  const active = useRef<Mark | null>(null);
  const textMove = useRef<{
    index: number;
    original: Mark;
    start: Point;
    mark: Mark;
    moved: boolean;
  } | null>(null);
  const [movingText, setMovingText] = useState<{
    index: number;
    mark: Mark;
  } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const [tool, setTool] = useState<Tool>("view");
  const [penTool, setPenTool] = useState<"pen" | "highlighter">("pen");
  const [color, setColor] = useState("#e03131");
  const [highlightColor, setHighlightColor] = useState("#ffd43b");
  const drawColor = tool === "highlighter" ? highlightColor : color;
  const [history, setHistory] = useState<{
    past: Mark[][];
    present: Mark[];
    future: Mark[][];
  }>({ past: [], present: [], future: [] });
  const marks = history.present;
  const [editingText, setEditingText] = useState<{
    index: number | null;
    mark: Mark;
  } | null>(null);
  function commit(next: Mark[]) {
    setHistory((old) => markupHistory(old, { type: "commit", marks: next }));
  }
  function textMarks() {
    if (!editingText) return marks;
    const { index, mark } = editingText;
    const text = mark.text?.trim() || "";
    if (index === null) return text ? [...marks, { ...mark, text }] : marks;
    return text
      ? marks.map((m, i) => (i === index ? { ...mark, text } : m))
      : marks.filter((_, i) => i !== index);
  }
  function finishText() {
    if (!editingText) return;
    const next = textMarks();
    if (JSON.stringify(next) !== JSON.stringify(marks)) commit(next);
    setEditingText(null);
  }
  const [preview, setPreview] = useState<Mark | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [discard, setDiscard] = useState(false);
  const fit = size.width
    ? Math.max(
        0.02,
        Math.min(
          1,
          (viewport.width - 32) / size.width,
          (viewport.height - 32) / size.height,
        ),
      )
    : 1;
  const scale = zoom ?? fit;
  const scaleRef = useRef(scale);
  const zoomAnchor = useRef<{ point: Point; x: number; y: number } | null>(
    null,
  );
  function zoomAt(next: number, x?: number, y?: number) {
    const el = viewportElement.current;
    if (!el || !image.current || active.current || textMove.current) return;
    const rect = el.getBoundingClientRect();
    const clientX = x ?? rect.left + el.clientWidth / 2;
    const clientY = y ?? rect.top + el.clientHeight / 2;
    zoomAnchor.current = {
      point: imagePoint(
        clientX,
        clientY,
        image.current.getBoundingClientRect(),
        size.width,
        size.height,
      ),
      x: clientX,
      y: clientY,
    };
    scaleRef.current = next;
    setZoom(next);
  }
  useLayoutEffect(() => {
    scaleRef.current = scale;
    const el = viewportElement.current;
    const anchor = zoomAnchor.current;
    if (!el || !image.current || !anchor) return;
    const rect = image.current.getBoundingClientRect();
    el.scrollLeft += rect.left + anchor.point[0] * scale - anchor.x;
    el.scrollTop += rect.top + anchor.point[1] * scale - anchor.y;
    zoomAnchor.current = null;
  }, [scale]);
  useEffect(() => {
    const el = viewportElement.current;
    if (!el) return;
    function wheel(event: WheelEvent) {
      const next = wheelImageScale(scaleRef.current, event, el!.clientHeight);
      if (next === null || !size.width) return;
      event.preventDefault();
      if (saving || discard || active.current || textMove.current) return;
      zoomAt(next, event.clientX, event.clientY);
    }
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [size.width, size.height, saving, discard]);
  const lineWidth = Math.max(3, Math.min(size.width, size.height) / 250);
  const fontSize = Math.max(18, size.width / 45);
  const editorTextWidth = useMemo(() => {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return fontSize;
    ctx.font = `600 ${fontSize}px sans-serif`;
    return ctx.measureText(editingText?.mark.text || "Type here…").width;
  }, [editingText?.mark.text, fontSize]);
  const textPadding = 4;
  function shortcut(event: KeyboardEvent<HTMLElement>) {
    if (saving || discard || active.current || textMove.current) return;
    const action = imageHistoryShortcut(event);
    if (!action) return;
    event.preventDefault();
    setHistory((old) => markupHistory(old, { type: action }));
  }
  function close() {
    if (saving) return;
    if (marks.length || editingText?.mark.text?.trim()) setDiscard(true);
    else onClose();
  }
  function point(e: { clientX: number; clientY: number }) {
    return imagePoint(
      e.clientX,
      e.clientY,
      image.current!.getBoundingClientRect(),
      size.width,
      size.height,
    );
  }
  function start(e: PointerEvent<SVGSVGElement>) {
    if (tool === "view" || saving || e.button !== 0 || !size.width) return;
    if (marks.length >= 100) {
      setError("Save this copy before adding more markup.");
      return;
    }
    e.preventDefault();
    viewportElement.current?.focus();
    const p = point(e);
    if (tool === "text") {
      setEditingText({
        index: null,
        mark: {
          tool: "text",
          points: [[p[0], Math.min(size.height, p[1] + fontSize)]],
          color,
          text: "",
        },
      });
      setError("");
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    active.current = { tool, color: drawColor, points: [p, p] };
    setPreview(active.current);
    setError("");
  }
  function move(e: PointerEvent<SVGSVGElement>) {
    const drag = textMove.current;
    if (drag) {
      const p = point(e);
      const dx = p[0] - drag.start[0],
        dy = p[1] - drag.start[1];
      if (!drag.moved && Math.hypot(dx, dy) * scale < 3) return;
      drag.moved = true;
      drag.mark = {
        ...drag.original,
        points: [
          [
            Math.max(0, Math.min(size.width, drag.original.points[0][0] + dx)),
            Math.max(
              fontSize,
              Math.min(size.height, drag.original.points[0][1] + dy),
            ),
          ],
        ],
      };
      setMovingText({ index: drag.index, mark: drag.mark });
      return;
    }
    const mark = active.current;
    if (!mark) return;
    const p = point(e);
    active.current = {
      ...mark,
      points:
        mark.tool === "pen" || mark.tool === "highlighter"
          ? [...mark.points.slice(-1999), p]
          : [mark.points[0], p],
    };
    setPreview(active.current);
  }
  function finish(e: PointerEvent<SVGSVGElement>) {
    if (textMove.current) {
      move(e);
      const drag = textMove.current;
      textMove.current = null;
      setMovingText(null);
      if (drag.moved)
        commit(
          marks.map((mark, index) => (index === drag.index ? drag.mark : mark)),
        );
      else setEditingText({ index: drag.index, mark: { ...drag.original } });
      return;
    }
    if (!active.current) return;
    move(e);
    const mark = active.current;
    if (mark) commit([...marks, mark]);
    active.current = null;
    setPreview(null);
  }
  async function save() {
    const savedMarks = textMarks();
    if (!onSave || !image.current || !size.width || !savedMarks.length) return;
    finishText();
    setSaving(true);
    setError("");
    try {
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw Error("Image editing is unavailable in this browser.");
      ctx.drawImage(image.current, 0, 0);
      for (const mark of savedMarks) {
        ctx.save();
        ctx.globalAlpha = mark.tool === "highlighter" ? 0.35 : 1;
        ctx.strokeStyle = mark.color;
        ctx.fillStyle = mark.color;
        ctx.lineWidth = mark.tool === "highlighter" ? lineWidth * 5 : lineWidth;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        const first = mark.points[0],
          last = mark.points.at(-1)!;
        if (mark.tool === "text") {
          ctx.font = `600 ${fontSize}px sans-serif`;
          ctx.fillText(mark.text || "", first[0], first[1]);
        } else if (mark.tool === "rectangle")
          ctx.strokeRect(
            first[0],
            first[1],
            last[0] - first[0],
            last[1] - first[1],
          );
        else {
          ctx.beginPath();
          ctx.moveTo(first[0], first[1]);
          for (const p of mark.points.slice(1)) ctx.lineTo(p[0], p[1]);
          ctx.stroke();
          if (mark.tool === "arrow") {
            const head = arrowHead(first, last, lineWidth * 7);
            ctx.beginPath();
            ctx.moveTo(head[0][0], head[0][1]);
            for (const p of head.slice(1)) ctx.lineTo(p[0], p[1]);
            ctx.closePath();
            ctx.fill();
          }
        }
        ctx.restore();
      }
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) =>
            b ? resolve(b) : reject(Error("Couldn’t create the PNG copy.")),
          "image/png",
        ),
      );
      if (blob.size > 4 * 1024 * 1024)
        throw Error(
          "The marked-up copy exceeds the 4 MB attachment limit. The original is unchanged.",
        );
      await onSave(
        new File([blob], name.replace(/\.png$/i, "") + " annotated.png", {
          type: "image/png",
        }),
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  function shape(mark: Mark, index: number) {
    const a = mark.points[0],
      b = mark.points.at(-1)!;
    if (mark.tool === "text")
      return (
        <text
          key={index}
          x={a[0]}
          y={a[1]}
          fill={mark.color}
          fontSize={fontSize}
          fontWeight={600}
          fontFamily="sans-serif"
          role={tool === "text" ? "button" : undefined}
          aria-label={
            tool === "text" ? `Edit annotation: ${mark.text}` : undefined
          }
          tabIndex={tool === "text" ? 0 : undefined}
          style={{ cursor: tool === "text" ? "move" : undefined }}
          onPointerDown={(e) => {
            if (tool !== "text" || saving) return;
            e.preventDefault();
            e.stopPropagation();
            viewportElement.current?.focus();
            textMove.current = {
              index,
              original: mark,
              start: point(e),
              mark,
              moved: false,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onKeyDown={(e) => {
            if (tool === "text" && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              setEditingText({ index, mark: { ...mark } });
            }
          }}
        >
          {mark.text}
        </text>
      );
    if (mark.tool === "rectangle")
      return (
        <rect
          key={index}
          x={Math.min(a[0], b[0])}
          y={Math.min(a[1], b[1])}
          width={Math.abs(b[0] - a[0])}
          height={Math.abs(b[1] - a[1])}
          fill="none"
          stroke={mark.color}
          strokeWidth={lineWidth}
        />
      );
    return (
      <g key={index} opacity={mark.tool === "highlighter" ? 0.35 : 1}>
        <polyline
          points={mark.points.map((p) => p.join(",")).join(" ")}
          fill="none"
          stroke={mark.color}
          strokeWidth={mark.tool === "highlighter" ? lineWidth * 5 : lineWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {mark.tool === "arrow" && (
          <polygon
            points={arrowHead(a, b, lineWidth * 7)
              .map((p) => p.join(","))
              .join(" ")}
            fill={mark.color}
          />
        )}
      </g>
    );
  }
  return (
    <>
      <Modal
        opened
        title={name}
        onClose={close}
        size={1200}
        centered
        zIndex={280}
        closeOnEscape={!saving && !discard}
        closeOnClickOutside={false}
        closeButtonProps={{ "aria-label": "Close image", disabled: saving }}
        onKeyDown={shortcut}
        styles={{
          body: { maxHeight: "calc(100dvh - 180px)", overflowY: "auto" },
        }}
      >
        <Stack gap="sm">
          <Group justify="space-between">
            <Group gap="xs">
              <Button
                variant={zoom === null ? "light" : "default"}
                size="xs"
                onClick={() => setZoom(null)}
              >
                Fit
              </Button>
              <Button
                variant={zoom === 1 ? "light" : "default"}
                size="xs"
                onClick={() => zoomAt(1)}
              >
                100%
              </Button>
              <Tooltip label="Zoom out">
                <ActionIcon
                  aria-label="Zoom out"
                  variant="default"
                  onClick={() => zoomAt(Math.max(0.02, scale / 1.25))}
                >
                  <ZoomOut size={16} />
                </ActionIcon>
              </Tooltip>
              <Text size="xs" c="dimmed" w={40} ta="center">
                {Math.round(scale * 100)}%
              </Text>
              <Tooltip label="Zoom in">
                <ActionIcon
                  aria-label="Zoom in"
                  variant="default"
                  onClick={() => zoomAt(Math.min(4, scale * 1.25))}
                >
                  <ZoomIn size={16} />
                </ActionIcon>
              </Tooltip>
            </Group>
            {onSave && tool === "view" && (
              <Button
                size="xs"
                variant="default"
                leftSection={<Pencil size={14} />}
                disabled={!size.width}
                onClick={() => setTool(penTool)}
              >
                Mark up
              </Button>
            )}
          </Group>
          {tool !== "view" && (
            <>
              <SegmentedControl
                aria-label="Image markup tool"
                value={tool === "highlighter" ? "pen" : tool}
                onChange={(value) =>
                  setTool(value === "pen" ? penTool : (value as Tool))
                }
                disabled={saving}
                data={[
                  { value: "view", label: "View" },
                  { value: "pen", label: "Pen" },
                  { value: "arrow", label: "Arrow" },
                  { value: "rectangle", label: "Rectangle" },
                  { value: "text", label: "Text" },
                ]}
              />
              <Group justify="space-between">
                <Group
                  gap="sm"
                  className="td-image-colors"
                  aria-label="Markup color"
                >
                  {[
                    ["Red", "#e03131"],
                    ["Blue", "#1971c2"],
                    ["Yellow", "#ffd43b"],
                    ["Black", "#212529"],
                  ].map(([label, value]) => (
                    <Tooltip label={`${label} markup`} key={value}>
                      <ActionIcon
                        variant="filled"
                        size={22}
                        style={{ backgroundColor: value, borderRadius: "50%" }}
                        aria-label={`${label} markup`}
                        aria-pressed={drawColor === value}
                        disabled={saving}
                        onClick={() =>
                          tool === "highlighter"
                            ? setHighlightColor(value)
                            : setColor(value)
                        }
                      >
                        {drawColor === value ? (
                          <Check size={13} color="white" />
                        ) : null}
                      </ActionIcon>
                    </Tooltip>
                  ))}
                  {(tool === "pen" || tool === "highlighter") && (
                    <Group
                      gap={6}
                      wrap="nowrap"
                      ml="xs"
                      aria-label="Drawing tools"
                    >
                      {(
                        [
                          ["pen", "Pen", Pencil],
                          ["highlighter", "Highlighter", Highlighter],
                        ] as const
                      ).map(([value, label, Icon]) => (
                        <Tooltip label={label} key={value}>
                          <ActionIcon
                            aria-label={label}
                            aria-pressed={tool === value}
                            variant={tool === value ? "light" : "default"}
                            color={tool === value ? undefined : "gray"}
                            size={30}
                            disabled={saving}
                            onClick={() => {
                              setPenTool(value);
                              setTool(value);
                            }}
                          >
                            <Icon size={16} />
                          </ActionIcon>
                        </Tooltip>
                      ))}
                    </Group>
                  )}
                </Group>
                <Group gap={6} wrap="nowrap" aria-label="Markup history">
                  <Tooltip label="Undo (⌘Z / Ctrl+Z)">
                    <ActionIcon
                      aria-label="Undo"
                      variant="default"
                      size={30}
                      disabled={!history.past.length || saving}
                      onClick={() =>
                        setHistory((old) =>
                          markupHistory(old, { type: "undo" }),
                        )
                      }
                    >
                      <Undo2 size={16} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Redo (⇧⌘Z / Ctrl+Shift+Z)">
                    <ActionIcon
                      aria-label="Redo"
                      variant="default"
                      size={30}
                      disabled={!history.future.length || saving}
                      onClick={() =>
                        setHistory((old) =>
                          markupHistory(old, { type: "redo" }),
                        )
                      }
                    >
                      <Redo2 size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Group>
            </>
          )}
          {error && (
            <Alert color="red" role="alert">
              {error}
            </Alert>
          )}
          <div
            ref={setViewportRef}
            className="td-image-viewport"
            aria-label="Expanded task image"
            tabIndex={-1}
            style={{
              height:
                tool === "view"
                  ? "min(65vh, calc(100dvh - 320px))"
                  : "min(55vh, calc(100dvh - 420px))",
            }}
          >
            <div
              className="td-image-stage"
              style={{
                width: size.width ? size.width * scale : "100%",
                height: size.height ? size.height * scale : "auto",
              }}
            >
              <img
                ref={image}
                src={src}
                alt={name}
                draggable={false}
                onLoad={(e) => {
                  setSize({
                    width: e.currentTarget.naturalWidth,
                    height: e.currentTarget.naturalHeight,
                  });
                  setError("");
                }}
                onError={() =>
                  setError(
                    "Couldn’t load this attachment. Close the image and reopen the task to retry.",
                  )
                }
              />
              {size.width > 0 && (
                <svg
                  viewBox={`0 0 ${size.width} ${size.height}`}
                  role="img"
                  aria-label="Image markup"
                  style={{
                    touchAction: tool === "view" ? "auto" : "none",
                    pointerEvents: tool === "view" ? "none" : "auto",
                    cursor: tool === "view" ? "auto" : "crosshair",
                  }}
                  onPointerDown={start}
                  onPointerMove={move}
                  onPointerUp={finish}
                  onPointerCancel={() => {
                    active.current = null;
                    textMove.current = null;
                    setMovingText(null);
                    setPreview(null);
                  }}
                >
                  {marks.map((mark, index) =>
                    editingText?.index === index
                      ? null
                      : shape(
                          movingText?.index === index ? movingText.mark : mark,
                          index,
                        ),
                  )}
                  {preview && shape(preview, -1)}
                </svg>
              )}
              {editingText && (
                <TextInput
                  key={editingText.index ?? "new"}
                  autoFocus
                  aria-label="Annotation text"
                  placeholder="Type here…"
                  value={editingText.mark.text || ""}
                  maxLength={120}
                  disabled={saving}
                  onChange={(e) =>
                    setEditingText({
                      ...editingText,
                      mark: {
                        ...editingText.mark,
                        text: e.currentTarget.value,
                      },
                    })
                  }
                  onBlur={finishText}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                      e.preventDefault();
                      finishText();
                      viewportElement.current?.focus();
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setEditingText(null);
                      viewportElement.current?.focus();
                    }
                  }}
                  className="td-image-text-editor"
                  style={{
                    left:
                      editingText.mark.points[0][0] * scale - textPadding - 1,
                    top: Math.max(
                      0,
                      (editingText.mark.points[0][1] - fontSize) * scale -
                        textPadding -
                        1,
                    ),
                    width: editorTextWidth * scale + 2 * textPadding + 2,
                  }}
                  styles={{
                    input: {
                      color: editingText.mark.color,
                      fontSize: fontSize * scale,
                      fontWeight: 600,
                      fontFamily: "sans-serif",
                      lineHeight: 1.2,
                      height: fontSize * scale * 1.2 + 2 * textPadding + 2,
                      minHeight: 0,
                      padding: textPadding,
                      border: "1px dotted var(--mantine-primary-color-filled)",
                      borderRadius: 2,
                      background: "transparent",
                    },
                  }}
                />
              )}
            </div>
          </div>
          <Group justify="space-between" className="td-image-actions">
            <Text size="xs" c="dimmed">
              {tool === "view"
                ? "Pinch or Ctrl+scroll to zoom. Scroll to move around the image."
                : tool === "text"
                  ? "Click to type or edit. Drag a label to move it. Enter finishes; Escape cancels."
                  : draft
                    ? "Original kept. Add a copy to this draft, then save the task."
                    : "Original kept. Markup is saved as a new PNG attachment."}
            </Text>
            {onSave && textMarks().length > 0 && (
              <Button size="sm" onClick={() => void save()} loading={saving}>
                {draft ? "Add marked-up copy" : "Save marked-up copy"}
              </Button>
            )}
          </Group>
        </Stack>
      </Modal>
      <Modal
        opened={discard}
        onClose={() => setDiscard(false)}
        title="Discard unsaved markup?"
        centered
        zIndex={290}
        closeButtonProps={{ "aria-label": "Keep editing image" }}
      >
        <Text size="sm">
          Your original image is unchanged. The marks on this preview have not
          been saved.
        </Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setDiscard(false)}>
            Keep editing
          </Button>
          <Button color="red" onClick={onClose}>
            Discard markup
          </Button>
        </Group>
      </Modal>
    </>
  );
}
