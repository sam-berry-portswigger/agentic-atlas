import {
  mapTransform,
  topicRegions,
  insideRings,
} from "../shared/map-geometry.js";
import Markdown from "./Markdown.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppearance } from "./ui/Appearance";
import { Maximize2, Minus, Plus, RotateCcw } from "lucide-react";
import { visibleAgeRange, ageOpacity } from "../shared/map-age.js";
import { formatDate, type Point } from "./api";
type Region = {
  cluster: number;
  rings: { x: number; y: number }[][];
  anchor: { x: number; y: number } | null;
  cells: number;
  points: Point[];
  color: string;
  name: string;
};
export default function EmbeddingMap({
  points,
  project,
  highlighted,
  emptyMessage,
  activeCluster = null,
  fadeOlder = false,
  regionsMode = false,
  onSelect,
}: {
  points: Point[];
  project: string;
  highlighted: Set<string>;
  emptyMessage?: string;
  activeCluster?: number | null;
  fadeOlder?: boolean;
  regionsMode?: boolean;
  onSelect: (id: string) => void;
}) {
  const { resolvedMode } = useAppearance();
  const canvas = useRef<HTMLCanvasElement>(null),
    container = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const isHighlighted = (p: Point) =>
    highlighted.has(p.id) || !!(p.session && highlighted.has(p.session));
  const [size, setSize] = useState({ w: 800, h: 480 });
  const [hover, setHover] = useState<{
    point: Point;
    x: number;
    y: number;
  } | null>(null);
  const dragging = useRef<{
    x: number;
    y: number;
    vx: number;
    vy: number;
    moved: boolean;
  } | null>(null);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([e]) =>
      setSize({ w: e.contentRect.width, h: e.contentRect.height }),
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = canvas.current;
    if (!el || !points.length) return;
    const wheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left - rect.width / 2;
      const y = e.clientY - rect.top - rect.height / 2;
      // Trackpads emit many tiny deltas; scale by distance rather than event count.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
      const delta = Math.max(-50, Math.min(50, e.deltaY * unit));
      setView((v) => {
        const zoom = Math.max(
          0.5,
          Math.min(5, v.zoom * Math.exp(-delta * 0.002)),
        );
        const ratio = zoom / v.zoom;
        // Preserve the map coordinate beneath the cursor, including after panning.
        return {
          zoom,
          x: x - (x - v.x) * ratio,
          y: y - (y - v.y) * ratio,
        };
      });
      setHover(null);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [points.length]);
  const geometry = useMemo(
    () => mapTransform(points, size, view),
    [points, size, view],
  );
  const screen = geometry.point;
  const regions = useMemo<Region[]>(
    () => (regionsMode ? topicRegions(points) : []),
    [points, regionsMode],
  );
  const ages = useMemo(() => visibleAgeRange(points), [points]);
  // Measure nearby passages before zooming so intensity stays stable while exploring.
  const density = useMemo(() => {
    const cell = 24;
    const positions = points.map(mapTransform(points, size).point);
    const bins = new Map<string, number>();
    positions.forEach(({ x, y }, i) => {
      if (project && points[i].project !== project) return;
      const key = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
      bins.set(key, (bins.get(key) || 0) + 1);
    });
    const values = positions.map(({ x, y }) => {
      let total = 0;
      const bx = Math.floor(x / cell),
        by = Math.floor(y / cell);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          const count = bins.get(`${bx + dx},${by + dy}`) || 0;
          const distance =
            ((bx + dx + 0.5) * cell - x) ** 2 +
            ((by + dy + 0.5) * cell - y) ** 2;
          total += count * Math.exp(-distance / (2 * cell ** 2));
        }
      }
      return total;
    });
    const peak = values.reduce((max, value) => Math.max(max, value), 1);
    return values.map((value) => Math.log1p(value) / Math.log1p(peak));
  }, [points, project, size]);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = size.w * dpr;
    el.height = size.h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.fillStyle = resolvedMode === "dark" ? "#3a4654" : "#e4e7eb";
    for (let x = 20; x < size.w; x += 24)
      for (let y = 18; y < size.h; y += 24) {
        ctx.beginPath();
        ctx.arc(x, y, 0.65, 0, Math.PI * 2);
        ctx.fill();
      }
    const isDimmed = (p: Point) =>
      !!(
        (project && p.project !== project) ||
        (activeCluster !== null && p.cluster !== activeCluster) ||
        (activeCluster === null && highlighted.size > 0 && !isHighlighted(p))
      );

    // Composite the haze once at low opacity: even dense overlaps stay subtle.
    const haze = document.createElement("canvas");
    haze.width = el.width;
    haze.height = el.height;
    const hazeCtx = haze.getContext("2d");
    if (hazeCtx && !regionsMode) {
      hazeCtx.scale(dpr, dpr);
      points.forEach((p) => {
        if (isDimmed(p)) return;
        const pos = screen(p);
        hazeCtx.globalAlpha =
          fadeOlder && !isHighlighted(p) ? ageOpacity(p.timestamp, ages) : 1;
        const color = p.color;
        const radius = 20;
        const glow = hazeCtx.createRadialGradient(
          pos.x,
          pos.y,
          0,
          pos.x,
          pos.y,
          radius,
        );
        glow.addColorStop(0, color + "60");
        glow.addColorStop(0.4, color + "30");
        glow.addColorStop(1, color + "00");
        hazeCtx.fillStyle = glow;
        hazeCtx.fillRect(
          pos.x - radius,
          pos.y - radius,
          radius * 2,
          radius * 2,
        );
      });
      ctx.globalAlpha = 0.34;
      ctx.drawImage(haze, 0, 0, size.w, size.h);
      ctx.globalAlpha = 1;
    }
    if (regionsMode) {
      const occupied: { x: number; y: number; w: number; h: number }[] = [];
      const ordered = [...regions].sort(
        (a, b) =>
          Number(b.cluster === activeCluster) -
            Number(a.cluster === activeCluster) || b.cells - a.cells,
      );
      for (const region of ordered) {
        const dim = region.points.every(isDimmed),
          path = new Path2D();
        for (const ring of region.rings) {
          const pathPoints = ring.map(screen),
            last = pathPoints[pathPoints.length - 1],
            first = pathPoints[0];
          path.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
          pathPoints.forEach((point, index) => {
            const next = pathPoints[(index + 1) % pathPoints.length];
            path.quadraticCurveTo(
              point.x,
              point.y,
              (point.x + next.x) / 2,
              (point.y + next.y) / 2,
            );
          });
          path.closePath();
        }
        const age = fadeOlder
          ? region.points.reduce(
              (sum, point) => sum + ageOpacity(point.timestamp, ages),
              0,
            ) / region.points.length
          : 1;
        ctx.globalAlpha = (dim ? 0.035 : 0.18) * age;
        ctx.fillStyle = region.color;
        ctx.fill(path, "evenodd");
        ctx.globalAlpha = (dim ? 0.15 : 0.72) * age;
        ctx.strokeStyle = region.color;
        ctx.lineWidth = 1.2;
        ctx.lineJoin = "round";
        ctx.stroke(path);
        ctx.globalAlpha = 1;
        if (
          !region.anchor ||
          region.cells < 45 ||
          dim ||
          (region.points.length < 3 && activeCluster !== region.cluster)
        )
          continue;
        const pos = screen(region.anchor),
          words = region.name.split(" "),
          lines: string[] = [];
        for (const word of words) {
          const last = lines.at(-1);
          if (last && last.length + word.length < 30)
            lines[lines.length - 1] += " " + word;
          else lines.push(word);
        }
        const visible = lines.slice(0, 2);
        if (lines.length > 2) visible[1] += "…";
        ctx.font = "600 11px system-ui";
        const width =
            Math.max(...visible.map((line) => ctx.measureText(line).width)) +
            12,
          height = visible.length * 15 + 6;
        const box = {
          x: pos.x - width / 2,
          y: pos.y - height / 2,
          w: width,
          h: height,
        };
        if (
          box.x < 5 ||
          box.x + width > size.w - 5 ||
          box.y < 5 ||
          box.y + height > size.h - 45 ||
          occupied.some(
            (other) =>
              box.x < other.x + other.w &&
              box.x + box.w > other.x &&
              box.y < other.y + other.h &&
              box.y + box.h > other.y,
          )
        )
          continue;
        occupied.push(box);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.strokeStyle = resolvedMode === "dark" ? "#1d252f" : "#ffffff";
        ctx.lineWidth = 4;
        ctx.lineJoin = "round";
        visible.forEach((line, index) => {
          const y = box.y + 8 + index * 15;
          ctx.strokeText(line, pos.x, y);
          ctx.fillStyle = resolvedMode === "dark" ? "#dbe4ef" : "#40534a";
          ctx.fillText(line, pos.x, y);
        });
      }
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    }
    // Draw crisp points above the haze; deeper colour means more nearby passages.
    points.forEach((p, i) => {
      const pos = screen(p),
        active = isHighlighted(p),
        dim = isDimmed(p);
      const color = p.color;
      ctx.globalAlpha = active
        ? 1
        : (dim ? 0.12 : regionsMode ? 0.25 : 0.94) *
          (fadeOlder ? ageOpacity(p.timestamp, ages) : 1);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(
        pos.x,
        pos.y,
        active ? 4.5 : regionsMode ? 1.3 : 2.5 + 0.5 * density[i],
        0,
        Math.PI * 2,
      );
      ctx.fill();
      if (active) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 7, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
  }, [
    points,
    project,
    highlighted,
    view,
    size,
    activeCluster,
    density,
    fadeOlder,
    ages,
    regions,
    regionsMode,
    resolvedMode,
  ]);
  function nearest(x: number, y: number) {
    if (regionsMode) {
      const world = geometry.inverse(x, y);
      const region = regions.find((region) => insideRings(world, region.rings));
      if (!region) return undefined;
      return region.points.reduce(
        (best, point) =>
          Math.hypot(point.x - world.x, point.y - world.y) <
          Math.hypot(best.x - world.x, best.y - world.y)
            ? point
            : best,
        region.points[0],
      );
    }

    let best: Point | undefined,
      dist = 13;
    for (const p of points) {
      if (project && p.project !== project) continue;
      const s = screen(p);
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < dist) {
        best = p;
        dist = d;
      }
    }
    return best;
  }
  const zoom = (factor: number) =>
    setView((v) => ({
      ...v,
      zoom: Math.max(0.5, Math.min(5, v.zoom * factor)),
    }));
  return (
    <div className="map-canvas" ref={container}>
      <canvas
        ref={canvas}
        aria-label={`${regionsMode ? "Regions view" : "Semantic map"} of ${points.length} conversations. Use search or overview source links to inspect conversations with a keyboard.`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = {
            x: e.clientX,
            y: e.clientY,
            vx: view.x,
            vy: view.y,
            moved: false,
          };
        }}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect(),
            x = e.clientX - rect.left,
            y = e.clientY - rect.top;
          if (dragging.current) {
            const d = dragging.current;
            const dx = e.clientX - d.x,
              dy = e.clientY - d.y;
            if (Math.hypot(dx, dy) > 3) d.moved = true;
            setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
            setHover(null);
          } else {
            const p = nearest(x, y);
            setHover(p ? { point: p, x, y } : null);
          }
        }}
        onPointerUp={(e) => {
          const d = dragging.current;
          dragging.current = null;
          if (d && !d.moved) {
            const rect = e.currentTarget.getBoundingClientRect();
            const p = nearest(e.clientX - rect.left, e.clientY - rect.top);
            if (p) onSelect(p.id);
          }
        }}
        onPointerCancel={() => (dragging.current = null)}
        onPointerLeave={() => setHover(null)}
      />
      {!points.length && (
        <div className="map-empty">
          <div className="empty-orbit">
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <span>✧</span>
          </div>
          <h3>
            {emptyMessage
              ? "No conversations in this window."
              : "A little space for your big ideas."}
          </h3>
          <p>
            {emptyMessage || (
              <>
                Index your sessions to see conversations
                <br />
                find their place in your knowledge map.
              </>
            )}
          </p>
        </div>
      )}
      {hover && (
        <div
          className="map-tooltip"
          role="tooltip"
          style={{
            left: Math.max(8, Math.min(hover.x + 15, size.w - 255)),
            top: Math.max(8, hover.y - 145),
          }}
        >
          <div className="map-tooltip-topic">
            <i
              style={{
                background: hover.point.color,
              }}
            />
            {hover.point.topicName}
          </div>
          {regionsMode ? (
            <>
              <b>{hover.point.topicName}</b>
              <span>
                {
                  regions.find(
                    (region) => region.cluster === hover.point.cluster,
                  )?.points.length
                }{" "}
                mapped conversations · Click to explore topic
              </span>
            </>
          ) : (
            <>
              <b>{hover.point.title}</b>
              <Markdown>{hover.point.preview}</Markdown>
              <small>
                {formatDate(hover.point.timestamp)} ·{" "}
                {hover.point.approximate
                  ? "Approximate location · explore topic"
                  : "Click to explore this topic ↗"}
              </small>
            </>
          )}
        </div>
      )}
      {regionsMode && (
        <div className="sr-only">
          {regions.map((region) => (
            <button
              key={region.cluster}
              onClick={() => onSelect(region.points[0].id)}
            >
              Explore {region.name}
            </button>
          ))}
        </div>
      )}
      <div className="map-controls">
        <button aria-label="Zoom in" onClick={() => zoom(1.25)}>
          <Plus size={15} />
        </button>
        <button aria-label="Zoom out" onClick={() => zoom(0.8)}>
          <Minus size={15} />
        </button>
        <span />
        <button
          aria-label="Reset map"
          onClick={() => setView({ zoom: 1, x: 0, y: 0 })}
        >
          <RotateCcw size={14} />
        </button>
        <button
          aria-label="Expand map"
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void container.current?.requestFullscreen();
          }}
        >
          <Maximize2 size={14} />
        </button>
      </div>
      <div className="map-hint">
        {points.length
          ? "⌘ + scroll to zoom · Drag to explore · Click a topic"
          : "Your conversations will appear here"}
      </div>
      <div className="map-scale">
        <span />
        {Math.round(view.zoom * 100)}%
      </div>
    </div>
  );
}
