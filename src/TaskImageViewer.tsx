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
import { useResizeObserver } from "@mantine/hooks";
import { Check, Pencil, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { useRef, useState, type PointerEvent } from "react";
import { arrowHead, imagePoint } from "../shared/image-markup.js";

type Point = [number, number];
type Tool = "view" | "pen" | "arrow" | "rectangle" | "text";
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
  const image = useRef<HTMLImageElement>(null);
  const active = useRef<Mark | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const [tool, setTool] = useState<Tool>("view");
  const [color, setColor] = useState("#e03131");
  const [label, setLabel] = useState("");
  const [marks, setMarks] = useState<Mark[]>([]);
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
  const lineWidth = Math.max(3, Math.min(size.width, size.height) / 250);
  const fontSize = Math.max(18, size.width / 45);
  function close() {
    if (saving) return;
    if (marks.length) setDiscard(true);
    else onClose();
  }
  function point(e: PointerEvent<SVGSVGElement>) {
    return imagePoint(
      e.clientX,
      e.clientY,
      e.currentTarget.getBoundingClientRect(),
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
    const p = point(e);
    if (tool === "text") {
      if (!label.trim()) {
        setError("Enter the label text first, then click where it belongs.");
        return;
      }
      setMarks((old) => [
        ...old,
        { tool: "text", points: [p], color, text: label.trim() },
      ]);
      setError("");
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    active.current = { tool, color, points: [p, p] };
    setPreview(active.current);
    setError("");
  }
  function move(e: PointerEvent<SVGSVGElement>) {
    const mark = active.current;
    if (!mark) return;
    const p = point(e);
    active.current = {
      ...mark,
      points:
        mark.tool === "pen"
          ? [...mark.points.slice(-1999), p]
          : [mark.points[0], p],
    };
    setPreview(active.current);
  }
  function finish(e: PointerEvent<SVGSVGElement>) {
    if (!active.current) return;
    move(e);
    const mark = active.current;
    if (mark) setMarks((old) => [...old, mark]);
    active.current = null;
    setPreview(null);
  }
  async function save() {
    if (!onSave || !image.current || !size.width || !marks.length) return;
    setSaving(true);
    setError("");
    try {
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw Error("Image editing is unavailable in this browser.");
      ctx.drawImage(image.current, 0, 0);
      for (const mark of marks) {
        ctx.strokeStyle = mark.color;
        ctx.fillStyle = mark.color;
        ctx.lineWidth = lineWidth;
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
      <g key={index}>
        <polyline
          points={mark.points.map((p) => p.join(",")).join(" ")}
          fill="none"
          stroke={mark.color}
          strokeWidth={lineWidth}
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
                onClick={() => setZoom(1)}
              >
                100%
              </Button>
              <Tooltip label="Zoom out">
                <ActionIcon
                  aria-label="Zoom out"
                  variant="default"
                  onClick={() => setZoom(Math.max(0.05, scale / 1.25))}
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
                  onClick={() => setZoom(Math.min(4, scale * 1.25))}
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
                onClick={() => setTool("pen")}
              >
                Mark up
              </Button>
            )}
          </Group>
          {tool !== "view" && (
            <>
              <SegmentedControl
                aria-label="Image markup tool"
                value={tool}
                onChange={(value) => setTool(value as Tool)}
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
                    ["Yellow", "#f08c00"],
                    ["Black", "#212529"],
                  ].map(([label, value]) => (
                    <Tooltip label={`${label} markup`} key={value}>
                      <ActionIcon
                        variant="filled"
                        size={22}
                        style={{ backgroundColor: value, borderRadius: "50%" }}
                        aria-label={`${label} markup`}
                        aria-pressed={color === value}
                        disabled={saving}
                        onClick={() => setColor(value)}
                      >
                        {color === value ? (
                          <Check size={13} color="white" />
                        ) : null}
                      </ActionIcon>
                    </Tooltip>
                  ))}
                </Group>
                {tool === "text" && (
                  <TextInput
                    aria-label="Annotation text"
                    placeholder="Type a label, then click to place it"
                    style={{ flex: "1 1 240px" }}
                    maxLength={120}
                    value={label}
                    onChange={(e) => setLabel(e.currentTarget.value)}
                    disabled={saving}
                  />
                )}
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={!marks.length || saving}
                  leftSection={<Undo2 size={13} />}
                  onClick={() => setMarks((old) => old.slice(0, -1))}
                >
                  Undo
                </Button>
              </Group>
            </>
          )}
          {error && (
            <Alert color="red" role="alert">
              {error}
            </Alert>
          )}
          <div
            ref={viewportRef}
            className="td-image-viewport"
            aria-label="Expanded task image"
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
                    setPreview(null);
                  }}
                >
                  {marks.map(shape)}
                  {preview && shape(preview, -1)}
                </svg>
              )}
            </div>
          </div>
          <Group justify="space-between" className="td-image-actions">
            <Text size="xs" c="dimmed">
              {tool === "view"
                ? "Zoom in to inspect details. Scroll to move around the image."
                : draft
                  ? "Original kept. Add a copy to this draft, then save the task."
                  : "Original kept. Markup is saved as a new PNG attachment."}
            </Text>
            {onSave && marks.length > 0 && (
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
