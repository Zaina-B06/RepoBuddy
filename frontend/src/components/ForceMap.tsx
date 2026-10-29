// The interactive map, in 3D (three.js) or 2D (canvas). Both use the same data and behaviour:
// hover lights up a node and its neighbours and shows what it is, click a folder to dive in,
// click a file to open it, and small particles travel along each line to show which way an import goes.
// The map is only rebuilt when its nodes change. Theme, the answer path and focus are applied in place,
// so the layout and camera stay where they are.
import { useEffect, useRef } from "react";
import ForceGraph3D from "3d-force-graph";
import ForceGraph from "force-graph";
import * as THREE from "three";
import SpriteText from "three-spritetext";
import { forceCollide, forceX, forceY, forceZ } from "d3-force-3d";
import type { MapEdge } from "../api";

export type MapNodeInput = {
  id: string;
  label: string;
  type: "folder" | "file";
  group: string;   // colour group: each folder in Folder view, top-level folder in Connections view
  size: number;    // lines of code
  info: string[];  // hover card lines (first line is the title)
  weight?: number; // 0..1 importance
};

type Props = {
  course: string[];        // ids of nodes on the current answer path, in order
  focusId: string | null;  // node to centre on and highlight
  mode: "folder" | "graph";
  dim: "3d" | "2d";
  nodes: MapNodeInput[];
  edges: MapEdge[];
  theme: "light" | "dark";
  onOpenFolder: (id: string) => void;
  onOpenFile: (id: string) => void;
};

type N = MapNodeInput & { x?: number; y?: number; z?: number; r: number; labelW: number };
type L = { source: string | N; target: string | N; kind: "import" | "route" | "course"; count: number };
type Colors = Record<"ink" | "quiet" | "sheet" | "edge" | "buoy" | "course", string> & { palette: string[] };

// What the effects below need from the running map.
type Live = {
  recolor: () => void;
  setCourse: (ids: string[]) => void;
  focus: (id: string | null) => void;
  reset: () => void; // clear the highlight and show the whole map again
};

const PALETTE = {
  light: ["#2f6f8f", "#7a5ea8", "#3f8a5b", "#b0761c", "#a8466b", "#2f8580", "#6b6f2f", "#8a5a3c"],
  dark: ["#6fb3d2", "#a891d8", "#7fc08c", "#e0b25a", "#e07fa3", "#6ccfc6", "#c2c66f", "#d19a74"],
};
const FONT_UI = '"Instrument Sans Variable", sans-serif';

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const readColors = (theme: "light" | "dark"): Colors => ({
  ink: css("--ink"), quiet: css("--quiet"), sheet: css("--sheet"), edge: css("--edge"),
  buoy: css("--buoy"), course: css("--course"), palette: PALETTE[theme],
});
const idOf = (end: string | N) => (typeof end === "string" ? end : end.id);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
function withAlpha(hex: string, a: number) {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
const measure = (() => {
  const ctx = document.createElement("canvas").getContext("2d")!;
  return (text: string, px: number, weight = 500) => {
    ctx.font = `${weight} ${px}px ${FONT_UI}`;
    return ctx.measureText(text).width;
  };
})();

export function ForceMap({ course, focusId, mode, dim, nodes, edges, theme, onOpenFolder, onOpenFile }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onOpenFolder, onOpenFile });
  handlers.current = { onOpenFolder, onOpenFile };
  const colors = useRef<Colors>(readColors(theme));
  const live = useRef<Live | null>(null);
  const courseRef = useRef(course);
  courseRef.current = course;
  const focusRef = useRef(focusId);
  focusRef.current = focusId;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const isGraph = mode === "graph";
    const is3d = dim === "3d";
    const groups = [...new Set(nodes.map((n) => n.group))].sort();
    const colorOf = (n: N) =>
      n.type === "folder" || isGraph ? colors.current.palette[groups.indexOf(n.group) % colors.current.palette.length] : colors.current.quiet;

    // Labels: always in Folder view; in Connections view for the most important files (others on hover).
    const labelled = new Set(
      [...nodes].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).slice(0, isGraph ? 25 : nodes.length).map((n) => n.id),
    );
    const ids = new Set(nodes.map((n) => n.id));
    const data = {
      nodes: nodes.map<N>((n) => ({
        ...n,
        // every node is a circle; folders are a little bigger and coloured, files are grey
        r: isGraph ? 2.5 + 4 * (n.weight ?? 0) : n.type === "folder" ? 5.5 : 4.5,
        labelW: measure(n.label, n.type === "folder" ? 14 : 12, n.type === "folder" ? 600 : 500) + 24,
      })),
      links: edges
        .filter((e) => ids.has(e.source) && ids.has(e.target))
        .map<L>((e) => ({ source: e.source, target: e.target, kind: e.kind, count: e.count ?? 1 })),
    };
    const byId = new Map(data.nodes.map((n) => [n.id, n]));

    // ----- the answer path (can change without rebuilding the map)
    let onCourse: string[] = [];
    let stepLabel = new Map<string, string>();
    const courseLinks = (): L[] => {
      const hops: L[] = [];
      for (let i = 1; i < onCourse.length; i++)
        if (onCourse[i] !== onCourse[i - 1]) hops.push({ source: onCourse[i - 1], target: onCourse[i], kind: "course", count: 1 });
      return hops;
    };
    let appliedKey = "";
    const applyCourse = (list: string[]) => {
      appliedKey = list.join("|");
      onCourse = list.filter((id) => byId.has(id));
      stepLabel = new Map();
      // number by the step's place in the whole answer, even if some steps aren't on this map
      list.forEach((id, i) => { if (byId.has(id)) stepLabel.set(id, stepLabel.has(id) ? `${stepLabel.get(id)},${i + 1}` : String(i + 1)); });
    };
    const labelOf = (n: N) => (stepLabel.has(n.id) ? `${stepLabel.get(n.id)}  ${n.label}` : n.label);
    const showsLabel = (n: N) => labelled.has(n.id) || stepLabel.has(n.id) || n.id === selected;
    applyCourse(courseRef.current);

    // ----- the selected node (a file picked in the tree, a search hit, or an answer step)
    let selected: string | null = null;

    // ----- hover state shared by both renderers
    let hovered: N | null = null;
    const near = new Set<string>();
    const nearLinks = new Set<L>();
    const setHover = (n: N | null, links: L[]) => {
      hovered = n;
      near.clear();
      nearLinks.clear();
      if (n) {
        near.add(n.id);
        for (const l of links) {
          if (l.kind !== "course" && (idOf(l.source) === n.id || idOf(l.target) === n.id)) {
            nearLinks.add(l);
            near.add(idOf(l.source));
            near.add(idOf(l.target));
          }
        }
      }
      el.style.cursor = n ? "pointer" : "";
    };
    const dimmed = (id: string) => hovered !== null && !near.has(id);
    const linkColor = (l: L) => {
      const c = colors.current;
      if (l.kind === "course") return withAlpha(c.course, hovered ? 0.45 : 0.95);
      const base = l.kind === "route" ? c.buoy : hovered && nearLinks.has(l) ? c.course : c.edge;
      const a = hovered ? (nearLinks.has(l) ? 0.95 : 0.15) : onCourse.length ? 0.3 : l.kind === "route" ? 0.9 : 0.6;
      return withAlpha(base, a);
    };
    const linkWidth = (l: L) =>
      l.kind === "course" ? (is3d ? 1.4 : 1.6) : (isGraph ? 0.5 : 0.6 + Math.sqrt(l.count) * 0.5) * (hovered && nearLinks.has(l) ? 1.8 : 1);
    const particles = (l: L) =>
      l.kind === "course" ? 4 : isGraph ? (nearLinks.has(l) ? 2 : 0) : onCourse.length ? 0 : Math.min(4, 1 + Math.floor(Math.sqrt(l.count)));
    const particleColor = (l: L) => (l.kind === "route" ? colors.current.buoy : l.kind === "course" ? "#ffffff" : colors.current.course);
    const open = (n: N) => (n.type === "folder" ? handlers.current.onOpenFolder(n.id) : handlers.current.onOpenFile(n.id));
    const card = (n: N) =>
      `<div class="tooltip-inner"><b>${esc(n.info[0])}</b>${n.info.slice(1).map((l) => `<div>${esc(l)}</div>`).join("")}</div>`;

    // forces: spread out, never overlap, stay together
    const degree = new Map<string, number>();
    for (const l of data.links) for (const id of [idOf(l.source), idOf(l.target)]) degree.set(id, (degree.get(id) ?? 0) + 1);
    const linkStrength = (l: L) =>
      l.kind === "course" ? 0 : 1 / Math.max(1, Math.min(degree.get(idOf(l.source)) ?? 1, degree.get(idOf(l.target)) ?? 1));
    const spread = is3d ? (isGraph ? -70 : -140) : isGraph ? -90 : -220;
    const pull = isGraph ? 0.07 : 0.14;
    const collide = forceCollide((n: N) =>
      is3d ? Math.max(n.r + 6, showsLabel(n) ? n.labelW * 0.3 : 0) : showsLabel(n) ? n.labelW / 2 + 6 : n.r + 4,
    ).iterations(2);

    let destroy: () => void;
    let resize: (w: number, h: number) => void;

    if (is3d) {
      const objects = new Map<string, { mesh: THREE.Mesh; mats: THREE.Material[]; label?: SpriteText }>();
      const makeLabel = (n: N) => {
        const c = colors.current;
        const step = stepLabel.has(n.id);
        const sel = n.id === selected && !step;
        const label = new SpriteText(labelOf(n), isGraph ? 5.5 : n.type === "folder" ? 6.5 : 6, step ? "#ffffff" : sel ? c.sheet : c.ink);
        label.fontFace = FONT_UI;
        label.fontWeight = n.type === "folder" || step || sel ? "600" : "500";
        label.backgroundColor = step ? c.course : sel ? c.ink : withAlpha(c.sheet, 0.85);
        label.padding = [3, 1.5];
        label.borderRadius = 3;
        label.position.set(0, n.r + 7, 0);
        const lm = label.material as THREE.SpriteMaterial;
        lm.depthWrite = false;
        lm.depthTest = false; // labels always drawn on top
        label.renderOrder = 10;
        return label;
      };
      // a ring around the selected node that always faces the camera
      const makeRing = (n: N) => {
        const cv = document.createElement("canvas");
        cv.width = cv.height = 128;
        const ctx = cv.getContext("2d")!;
        ctx.strokeStyle = colors.current.ink;
        ctx.lineWidth = 9;
        ctx.beginPath(); ctx.arc(64, 64, 56, 0, Math.PI * 2); ctx.stroke();
        const mat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, depthWrite: false, transparent: true });
        const ring = new THREE.Sprite(mat);
        const d = (n.r + 3.5) * 2;
        ring.scale.set(d, d, 1);
        ring.renderOrder = 9;
        return ring;
      };
      let ring: THREE.Sprite | null = null;
      const relabel = (id: string) => {
        const n = byId.get(id), o = objects.get(id), group = o?.mesh.parent;
        if (!n || !o || !group) return;
        if (o.label) { group.remove(o.label); o.mats = o.mats.filter((m) => m !== o.label!.material); o.label = undefined; }
        if (showsLabel(n)) { o.label = makeLabel(n); group.add(o.label); o.mats.push(o.label.material as THREE.Material); }
      };
      const select = (id: string | null) => {
        const prev = selected;
        selected = id;
        if (ring) { ring.parent?.remove(ring); ring = null; }
        if (prev && prev !== id) relabel(prev);
        if (id) {
          const group = objects.get(id)?.mesh.parent;
          if (group) { ring = makeRing(byId.get(id)!); group.add(ring); }
          relabel(id);
        }
      };
      const g = new ForceGraph3D(el, { controlType: "orbit", rendererConfig: { alpha: true, antialias: true } })
        .backgroundColor("rgba(0,0,0,0)")
        .showNavInfo(false)
        .graphData({ nodes: data.nodes, links: [...data.links, ...courseLinks()] })
        .nodeLabel((n) => card(n as N))
        .nodeThreeObject((obj) => {
          const n = obj as N;
          const group = new THREE.Group();
          const mat = new THREE.MeshLambertMaterial({ color: colorOf(n), transparent: true, opacity: 0.92 });
          const mesh = new THREE.Mesh(new THREE.SphereGeometry(n.r, 20, 14), mat);
          group.add(mesh);
          const entry: { mesh: THREE.Mesh; mats: THREE.Material[]; label?: SpriteText } = { mesh, mats: [mat] };
          if (showsLabel(n)) {
            entry.label = makeLabel(n);
            group.add(entry.label);
            entry.mats.push(entry.label.material as THREE.Material);
          }
          objects.set(n.id, entry);
          return group;
        })
        .linkColor((l) => linkColor(l as L))
        .linkWidth((l) => linkWidth(l as L))
        .linkOpacity(1)
        .linkDirectionalArrowLength((l) => ((l as L).kind === "course" ? 0 : isGraph ? 2.5 : 4))
        .linkDirectionalArrowRelPos(0.92)
        .linkDirectionalArrowColor((l) => linkColor(l as L))
        .linkDirectionalParticles((l) => particles(l as L))
        .linkDirectionalParticleWidth((l) => ((l as L).kind === "course" ? 2 : isGraph ? 1.2 : 1.8))
        .linkDirectionalParticleSpeed(0.006)
        .linkDirectionalParticleColor((l) => particleColor(l as L))
        .onNodeHover((n) => {
          setHover(n as N | null, g.graphData().links as L[]);
          for (const [id, o] of objects) for (const m of o.mats) m.opacity = dimmed(id) ? 0.3 : 0.95;
          restyleLinks();
        })
        .onNodeClick((obj) => {
          const n = obj as N;
          if (n.type === "folder") {
            flyTo(n, 60);
            setTimeout(() => open(n), 600);
          } else open(n);
        })
        .cooldownTicks(isGraph ? 160 : 120);
      const restyleLinks = () =>
        g.linkColor(g.linkColor()).linkWidth(g.linkWidth()).linkDirectionalParticles(g.linkDirectionalParticles())
          .linkDirectionalParticleColor(g.linkDirectionalParticleColor());

      // move the camera to look at a node from a fixed distance, keeping the current viewing direction
      const flyTo = (n: N, dist: number) => {
        const cam = g.cameraPosition();
        const v = { x: cam.x - (n.x ?? 0), y: cam.y - (n.y ?? 0), z: cam.z - (n.z ?? 0) };
        const len = Math.hypot(v.x, v.y, v.z) || 1;
        g.cameraPosition(
          { x: (n.x ?? 0) + (v.x / len) * dist, y: (n.y ?? 0) + (v.y / len) * dist, z: (n.z ?? 0) + (v.z / len) * dist },
          { x: n.x ?? 0, y: n.y ?? 0, z: n.z ?? 0 }, 700);
      };

      g.d3Force("charge")?.strength?.(spread);
      const link = g.d3Force("link") as unknown as { distance: (d: number) => unknown; strength: (f: (l: L) => number) => unknown };
      link?.distance?.(isGraph ? 40 : 60);
      link?.strength?.(linkStrength);
      g.d3Force("x", forceX(0).strength(pull)).d3Force("y", forceY(0).strength(pull)).d3Force("z", forceZ(0).strength(pull));
      g.d3Force("collide", collide);

      let settled = false;
      const fit = () => {
        if (settled) return;
        settled = true;
        if (focusRef.current) return live.current?.focus(focusRef.current);
        g.zoomToFit(500, 10);
        setTimeout(() => {
          // never start closer than this, so a folder with one or two items isn't a giant blob
          const p = g.cameraPosition();
          const d = Math.hypot(p.x, p.y, p.z);
          if (d < 160) g.cameraPosition({ x: (p.x / (d || 1)) * 160, y: (p.y / (d || 1)) * 160, z: (p.z / (d || 1)) * 160 }, undefined, 300);
        }, 520);
      };
      g.onEngineStop(fit);
      const early = setTimeout(fit, 1600);

      live.current = {
        recolor: () => {
          const c = colors.current;
          for (const [id, o] of objects) {
            (o.mesh.material as THREE.MeshLambertMaterial).color.set(colorOf(byId.get(id)!));
            if (o.label && !stepLabel.has(id)) { o.label.color = c.ink; o.label.backgroundColor = withAlpha(c.sheet, 0.85); }
            if (o.label && stepLabel.has(id)) o.label.backgroundColor = c.course;
          }
          if (selected) select(selected); // redraw the ring and label in the new theme's colours
          restyleLinks();
        },
        setCourse: (list) => {
          if (list.join("|") === appliedKey) return;
          applyCourse(list);
          // swap labels on nodes whose step number changed, then add the path lines without moving anything
          for (const n of data.nodes) {
            const o = objects.get(n.id);
            const group = o?.mesh.parent;
            if (!o || !group) continue;
            if (o.label) { group.remove(o.label); o.mats = o.mats.filter((m) => m !== o.label!.material); o.label = undefined; }
            if (showsLabel(n)) { o.label = makeLabel(n); group.add(o.label); o.mats.push(o.label.material as THREE.Material); }
          }
          const ticks = g.cooldownTicks();
          g.cooldownTicks(0).graphData({ nodes: data.nodes, links: [...data.links, ...courseLinks()] });
          setTimeout(() => g.cooldownTicks(ticks), 50);
          restyleLinks();
        },
        focus: (id) => {
          const n = id ? byId.get(id) : undefined;
          if (!n || n.x === undefined) return;
          setHover(n, g.graphData().links as L[]);
          for (const [oid, o] of objects) for (const m of o.mats) m.opacity = dimmed(oid) ? 0.3 : 0.95;
          restyleLinks();
          select(n.id);
          flyTo(n, 200);
        },
        reset: () => {
          select(null);
          setHover(null, g.graphData().links as L[]);
          for (const [, o] of objects) for (const m of o.mats) m.opacity = 0.95;
          restyleLinks();
          g.zoomToFit(600, 10);
          setTimeout(() => {
            const p = g.cameraPosition();
            const d = Math.hypot(p.x, p.y, p.z);
            if (d < 160) g.cameraPosition({ x: (p.x / (d || 1)) * 160, y: (p.y / (d || 1)) * 160, z: (p.z / (d || 1)) * 160 }, undefined, 300);
          }, 620);
        },
      };
      resize = (w, h) => g.width(w).height(h);
      destroy = () => { clearTimeout(early); g._destructor(); el.innerHTML = ""; };
    } else {
      let links: L[] = [...data.links, ...courseLinks()];
      const g = new ForceGraph(el)
        .graphData({ nodes: data.nodes, links })
        .backgroundColor("rgba(0,0,0,0)")
        .nodeLabel((n) => card(n as N))
        .nodeCanvasObject((obj, ctx, scale) => {
          const n = obj as N;
          const c = colors.current;
          const x = n.x ?? 0, y = n.y ?? 0;
          const color = colorOf(n);
          const step = stepLabel.has(n.id);
          ctx.globalAlpha = dimmed(n.id) ? 0.35 : 1;
          // the circle
          ctx.beginPath();
          ctx.arc(x, y, n.r, 0, 2 * Math.PI);
          ctx.fillStyle = step ? c.course : color;
          ctx.fill();
          if (hovered === n) { ctx.lineWidth = 2 / scale; ctx.strokeStyle = c.course; ctx.stroke(); }
          const sel = n.id === selected && !step;
          if (n.id === selected) {
            ctx.beginPath();
            ctx.arc(x, y, n.r + 3.5 / Math.sqrt(scale), 0, 2 * Math.PI);
            ctx.lineWidth = 2.2 / scale;
            ctx.strokeStyle = c.ink;
            ctx.stroke();
          }
          // the label, below the circle, the same size on screen at any zoom
          if (showsLabel(n) || hovered === n) {
            const px = (n.type === "folder" ? 12.5 : 11.5) / scale;
            ctx.font = `${n.type === "folder" || step || sel ? 600 : 500} ${px}px ${FONT_UI}`;
            const text = labelOf(n);
            const w = ctx.measureText(text).width + px * 1.1, h = px * 1.7;
            const ly = y + n.r + 3 / scale + h / 2;
            ctx.beginPath();
            ctx.roundRect(x - w / 2, ly - h / 2, w, h, px * 0.45);
            ctx.fillStyle = step ? c.course : sel ? c.ink : withAlpha(c.sheet, 0.9);
            ctx.fill();
            ctx.fillStyle = step ? "#ffffff" : sel ? c.sheet : c.ink;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(text, x, ly + px * 0.05);
          }
          ctx.globalAlpha = 1;
        })
        .nodePointerAreaPaint((obj, color, ctx, scale) => {
          // the circle and its label both count as the node, so hovering the label shows the card too
          const n = obj as N;
          const x = n.x ?? 0, y = n.y ?? 0;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(x, y, n.r + 4, 0, 2 * Math.PI);
          ctx.fill();
          if (showsLabel(n)) {
            const step = stepLabel.has(n.id);
            const px = (n.type === "folder" ? 12.5 : 11.5) / scale;
            ctx.font = `${n.type === "folder" || step ? 600 : 500} ${px}px ${FONT_UI}`;
            const w = ctx.measureText(labelOf(n)).width + px * 1.1, h = px * 1.7;
            ctx.fillRect(x - w / 2, y + n.r + 3 / scale, w, h);
          }
        })
        .linkColor((l) => linkColor(l as L))
        .linkWidth((l) => linkWidth(l as L) * 1.4)
        .linkLineDash((l) => ((l as L).kind === "route" ? [5, 4] : null))
        .linkDirectionalArrowLength((l) => ((l as L).kind === "course" ? 0 : isGraph ? 3 : 5))
        .linkDirectionalArrowRelPos(0.85)
        .linkDirectionalParticles((l) => particles(l as L))
        .linkDirectionalParticleWidth((l) => ((l as L).kind === "course" ? 3.5 : isGraph ? 2 : 3))
        .linkDirectionalParticleSpeed(0.006)
        .linkDirectionalParticleColor((l) => particleColor(l as L))
        .onNodeHover((n) => {
          setHover(n as N | null, links);
          g.linkDirectionalParticles(g.linkDirectionalParticles());
        })
        .onNodeClick((n) => open(n as N))
        .cooldownTicks(isGraph ? 200 : 150)
        .minZoom(0.3)
        .maxZoom(5);
      g.d3Force("charge")?.strength?.(spread);
      const link = g.d3Force("link") as unknown as { distance: (d: number) => unknown; strength: (f: (l: L) => number) => unknown };
      link?.distance?.(isGraph ? 45 : 90);
      link?.strength?.(linkStrength);
      g.d3Force("x", forceX(0).strength(pull)).d3Force("y", forceY(0).strength(pull));
      g.d3Force("collide", collide);

      let settled = false;
      const fit = () => {
        if (settled) return;
        settled = true;
        if (focusRef.current) return live.current?.focus(focusRef.current);
        g.zoomToFit(400, 70);
        setTimeout(() => { if (g.zoom() > 2) g.zoom(2, 250); }, 420); // don't blow up tiny folders
      };
      g.onEngineStop(fit);
      const early = setTimeout(fit, 1600);

      live.current = {
        recolor: () => { g.linkColor(g.linkColor()).linkDirectionalParticleColor(g.linkDirectionalParticleColor()); },
        setCourse: (list) => {
          if (list.join("|") === appliedKey) return;
          applyCourse(list);
          links = [...data.links, ...courseLinks()];
          const ticks = g.cooldownTicks();
          g.cooldownTicks(0).graphData({ nodes: data.nodes, links });
          setTimeout(() => g.cooldownTicks(ticks), 50);
          g.linkDirectionalParticles(g.linkDirectionalParticles());
        },
        focus: (id) => {
          const n = id ? byId.get(id) : undefined;
          if (!n || n.x === undefined) return;
          setHover(n, links);
          selected = n.id;
          g.linkDirectionalParticles(g.linkDirectionalParticles());
          g.centerAt(n.x, n.y, 600);
          g.zoom(Math.min(Math.max(g.zoom(), 1.6), 2.5), 600);
        },
        reset: () => {
          selected = null;
          setHover(null, links);
          g.linkDirectionalParticles(g.linkDirectionalParticles());
          g.zoomToFit(500, 70);
          setTimeout(() => { if (g.zoom() > 2) g.zoom(2, 250); }, 520);
        },
      };
      resize = (w, h) => g.width(w).height(h);
      destroy = () => { clearTimeout(early); g._destructor(); el.innerHTML = ""; };
    }

    const ro = new ResizeObserver(([entry]) => resize(entry.contentRect.width, entry.contentRect.height));
    ro.observe(el);
    return () => { ro.disconnect(); destroy(); live.current = null; };
  }, [mode, dim, nodes, edges]);

  // in-place updates: theme, answer path, focus
  useEffect(() => {
    colors.current = readColors(theme);
    live.current?.recolor();
  }, [theme]);
  const courseKey = course.join("|");
  useEffect(() => {
    live.current?.setCourse(courseRef.current);
  }, [courseKey]);
  const hadFocus = useRef(false);
  useEffect(() => {
    if (focusId) live.current?.focus(focusId);
    else if (hadFocus.current) live.current?.reset(); // focus cleared: zoom back out to the whole map
    hadFocus.current = !!focusId;
  }, [focusId]);

  return <div ref={box} className="cy" aria-label={mode === "folder" ? "Folder map" : "Connections map"} />;
}
