import { useCallback, useMemo, useRef, useState } from 'react';
import type { ApiNode, ApiEdge, LiveNode, NodeMeta, NodeType } from '../types';
import { api } from '../api';
import { Icon, ICONS, typeMeta } from '../ui/meta';
import { portsForType, portColor, type Port } from '../ports';

interface Props {
  nodes: ApiNode[];
  edges: ApiEdge[];
  live: Record<number, LiveNode>;
  focusContainer: number | null;
  selectedNodeId: number | null;
  selectedEdgeId: number | null;
  onSelectNode: (id: number) => void;
  onSelectEdge: (id: number) => void;
  onChanged: () => void;
  onHelp: () => void;
}

const G = { rackW: 300, headerH: 30, pad: 10, jackW: 15, jackH: 12, jackGap: 6, rowH: 23, devMinH: 42, devGap: 6, towerW: 150, towerH: 260, egW: 150, egH: 46 };
const HEALTH_HEX: Record<string, string> = { up: '#33cc7a', warning: '#f5b13d', down: '#f0556b', unknown: '#6b788f' };

/** Tipos que se pueden añadir a un rack / a una torre desde la barra contextual. */
const RACK_DEVICE_TYPES: NodeType[] = ['olt', 'mikrotik', 'switch', 'poe', 'patch', 'nap', 'onu', 'router'];
const TOWER_RADIO_TYPES: NodeType[] = ['ptp-mimosa', 'ap-ubiquiti', 'litebeam'];

function metaOf(n: ApiNode): NodeMeta { return (n.meta ?? {}) as NodeMeta; }
function effStatus(n: ApiNode, live: LiveNode | undefined): string {
  if (n.type === 'monitor') return 'up';
  if (!n.enabled) return 'unknown';
  const s = live?.status ?? 'unknown';
  return s === 'up' && live?.bwNear ? 'warning' : s;
}
function mediumFor(a: ApiNode, b: ApiNode, pa?: Port, pb?: Port): string {
  if (pa?.kind === 'wireless' || pb?.kind === 'wireless') return 'wireless'; // enlace de aire radio↔radio
  const fiber = ['olt', 'onu', 'nap'].includes(a.type) || ['olt', 'onu', 'nap'].includes(b.type) || pa?.kind === 'pon' || pb?.kind === 'pon';
  return fiber ? 'fiber' : 'copper';
}

interface Anchor { x: number; y: number; color: string }

export default function RackTowerView({ nodes, edges, live, focusContainer, selectedNodeId, selectedEdgeId, onSelectNode, onSelectEdge, onChanged, onHelp }: Props) {
  const [pan, setPan] = useState({ x: 40, y: 20 });
  const [zoom, setZoom] = useState(0.85);
  const [sel, setSel] = useState<{ kind: 'rack' | 'tower'; id: number } | null>(null);
  const [linkFrom, setLinkFrom] = useState<{ nodeId: number; portId: string } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef<number | null>(null);
  // true mientras/justo después de un arrastre real, para no abrir el drawer al soltar.
  const draggedRef = useRef(false);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // Selecciona un equipo SOLO si el gesto fue un clic (no un arrastre).
  const clickSelect = useCallback((id: number) => {
    if (draggedRef.current) { draggedRef.current = false; return; }
    onSelectNode(id);
  }, [onSelectNode]);

  // --- disposición: posiciones por defecto si no hay meta.phys ---
  const phys = useCallback((n: ApiNode, def: { x: number; y: number }) => {
    const p = metaOf(n).phys;
    return p && typeof p.x === 'number' ? p : def;
  }, []);

  const racks = useMemo(() => nodes.filter((n) => n.type === 'rack'), [nodes]);
  const towers = useMemo(() => nodes.filter((n) => n.type === 'torre'), [nodes]);

  const membersOf = useCallback(
    (containerId: number) => nodes.filter((n) => n.containerId === containerId)
      .sort((a, b) => (metaOf(a).slot ?? 999) - (metaOf(b).slot ?? 999) || a.id - b.id),
    [nodes],
  );

  // --- modelo geométrico (anclas de puertos en coordenadas del mundo) ---
  const model = useMemo(() => {
    const anchors = new Map<string, Anchor>();
    const rackViews: { node: ApiNode; x: number; y: number; h: number; devices: { node: ApiNode; y: number; h: number; ports: { port: Port; x: number; y: number }[] }[] }[] = [];
    const cols = Math.max(1, Math.floor((G.rackW - G.pad * 2) / (G.jackW + G.jackGap)));

    racks.forEach((rk, i) => {
      const base = phys(rk, { x: 340 + i * 360, y: 120 });
      const devs = membersOf(rk.id);
      let cy = base.y + G.headerH;
      const devViews: (typeof rackViews)[number]['devices'] = [];
      for (const d of devs) {
        const ports = portsForType(d);
        const rows = Math.max(1, Math.ceil(ports.length / cols));
        const devH = Math.max(G.devMinH, 22 + rows * G.rowH);
        const portViews = ports.map((p, idx) => {
          const c = idx % cols, r = Math.floor(idx / cols);
          const px = base.x + G.pad + G.jackW / 2 + c * (G.jackW + G.jackGap);
          const py = cy + 20 + r * G.rowH + G.jackH / 2;
          anchors.set(`${d.id}:${p.id}`, { x: px, y: py, color: portColor(p.kind) });
          return { port: p, x: px, y: py };
        });
        devViews.push({ node: d, y: cy, h: devH, ports: portViews });
        cy += devH + G.devGap;
      }
      const h = (cy - base.y) + G.pad + (devs.length ? 4 : 34);
      rackViews.push({ node: rk, x: base.x, y: base.y, h, devices: devViews });
    });

    const RW = 118, SLOT_H = 44; // separación vertical por radio (> alto de la tarjeta 40px)
    const towerViews: { node: ApiNode; x: number; y: number; twH: number; cx: number; apexY: number; baseY: number; rails: string; braces: string; radios: { node: ApiNode; y: number; x: number; mountLeft: number }[] }[] = [];
    towers.forEach((tw, i) => {
      const base = phys(tw, { x: 340 + racks.length * 360 + i * 240, y: 90 });
      const rads = membersOf(tw.id);
      // Alto dinámico: crece con los radios (mitad por lado) para que no se amontonen.
      const perSide = Math.ceil(rads.length / 2);
      const twH = Math.max(G.towerH, perSide * SLOT_H + 56);
      const cx = base.x + G.towerW / 2, apexY = base.y + 16, baseY = base.y + twH - 4;
      const baseHalf = G.towerW * 0.4, topHalf = 7;
      let braces = '';
      const segs = 8;
      for (let s = 0; s < segs; s++) {
        const f0 = s / segs, f1 = (s + 1) / segs;
        const y0 = baseY - f0 * (baseY - apexY), y1 = baseY - f1 * (baseY - apexY);
        const l0 = baseHalf + (topHalf - baseHalf) * f0, l1 = baseHalf + (topHalf - baseHalf) * f1;
        braces += `M ${cx - l0} ${y0} L ${cx + l1} ${y1} M ${cx + l0} ${y0} L ${cx - l1} ${y1} M ${cx - l1} ${y1} L ${cx + l1} ${y1} `;
      }
      const rails = `M ${cx - baseHalf} ${baseY} L ${cx - topHalf} ${apexY} M ${cx + baseHalf} ${baseY} L ${cx + topHalf} ${apexY}`;
      // Repartir en ambos lados (mitad y mitad, estable por id) y distribuir uniformemente por lado.
      const byId = [...rads].sort((a, b) => a.id - b.id);
      const side = new Map<number, 'L' | 'R'>(), sideK = new Map<number, number>(), cnt = { L: 0, R: 0 };
      byId.forEach((r) => { const s = (metaOf(r).side === 'L' || metaOf(r).side === 'R') ? metaOf(r).side! : (cnt.R <= cnt.L ? 'R' : 'L'); side.set(r.id, s); sideK.set(r.id, cnt[s]++); });
      const radViews = rads.map((r) => {
        const s = side.get(r.id)!, k = sideK.get(r.id)!;
        // Con mountF manual, respeta la altura; si no, apila de arriba abajo con paso fijo (sin solaparse).
        const mf = metaOf(r).mountF;
        const y = mf != null
          ? baseY - Math.max(0.06, Math.min(0.95, mf)) * (baseY - apexY)
          : apexY + 26 + k * SLOT_H;
        const half = topHalf + (baseHalf - topHalf) * (baseY - y) / (baseY - apexY);
        const cardLeft = s === 'R' ? cx + half + 14 : cx - half - 14 - RW;
        const mountLeft = s === 'R' ? cx + half : cardLeft + RW; // tramo de mástil hacia el radio
        const poeX = s === 'R' ? cardLeft - 4 : cardLeft + RW + 4; // PoE hacia la torre
        anchors.set(`${r.id}:poe`, { x: poeX, y: y + 20, color: '#57c7d4' });
        // Pin de aire (RF) hacia el par en otra torre: sobre el radio (lado que irradia).
        anchors.set(`${r.id}:air`, { x: cardLeft + RW / 2, y: y - 10, color: '#8b5bff' });
        return { node: r, y, x: cardLeft, mountLeft };
      });
      towerViews.push({ node: tw, x: base.x, y: base.y, twH, cx, apexY, baseY, rails, braces, radios: radViews });
    });

    // Egresos: nodos sueltos conectados a algún equipo dentro de un rack/torre.
    const containedIds = new Set<number>();
    nodes.forEach((n) => { if (n.containerId != null) containedIds.add(n.id); });
    const egressIds = new Set<number>();
    for (const e of edges) {
      const a = byId.get(e.source_id), b = byId.get(e.target_id);
      if (!a || !b) continue;
      if (containedIds.has(a.id) && !containedIds.has(b.id) && b.type !== 'rack' && b.type !== 'torre') egressIds.add(b.id);
      if (containedIds.has(b.id) && !containedIds.has(a.id) && a.type !== 'rack' && a.type !== 'torre') egressIds.add(a.id);
    }
    const egress = [...egressIds].map((id) => byId.get(id)!).filter(Boolean);
    const egViews = egress.map((n, i) => {
      const base = phys(n, { x: 60, y: 120 + i * 76 });
      anchors.set(`${n.id}:_`, { x: base.x + G.egW, y: base.y + G.egH / 2, color: '#4c8dff' });
      return { node: n, x: base.x, y: base.y };
    });

    return { rackViews, towerViews, egViews, anchors };
  }, [racks, towers, nodes, edges, byId, membersOf, phys]);

  // Ancla de un extremo de cable: puerto concreto, o el ancla única del egreso.
  const anchorFor = useCallback((nodeId: number, portId: string): Anchor | undefined => {
    return model.anchors.get(`${nodeId}:${portId}`) ?? model.anchors.get(`${nodeId}:_`);
  }, [model]);

  // Centrar en el contenedor al abrir desde la topología (una sola vez por foco).
  if (focusContainer != null && focusedRef.current !== focusContainer) {
    focusedRef.current = focusContainer;
    const c = byId.get(focusContainer);
    if (c) {
      const p = phys(c, { x: 340, y: 120 });
      // Centrado aproximado en el viewport.
      setTimeout(() => setPan({ x: -p.x * zoom + 360, y: -p.y * zoom + 120 }), 0);
    }
  }

  // --- persistencia de meta ---
  const patchMeta = useCallback((n: ApiNode, patch: Partial<NodeMeta>) => {
    void api.updateNode(n.id, { meta: { ...metaOf(n), ...patch } }).then(onChanged);
  }, [onChanged]);

  // --- interacciones de cableado ---
  const clickPort = useCallback((nodeId: number, portId: string) => {
    if (!linkFrom) { setLinkFrom({ nodeId, portId }); return; }
    if (linkFrom.nodeId === nodeId && linkFrom.portId === portId) { setLinkFrom(null); return; }
    // ¿ya existe un cable entre estos dos puertos?
    const dup = edges.some((e) =>
      (e.source_id === linkFrom.nodeId && e.source_port === linkFrom.portId && e.target_id === nodeId && e.target_port === portId) ||
      (e.target_id === linkFrom.nodeId && e.target_port === linkFrom.portId && e.source_id === nodeId && e.source_port === portId));
    if (dup) { setLinkFrom(null); return; }
    const aNode = byId.get(linkFrom.nodeId), bNode = byId.get(nodeId);
    if (!aNode || !bNode) { setLinkFrom(null); return; }
    const pa = portsForType(aNode).find((p) => p.id === linkFrom.portId);
    const pb = portsForType(bNode).find((p) => p.id === portId);
    void api.createEdge({
      sourceId: linkFrom.nodeId, targetId: nodeId,
      sourcePort: linkFrom.portId, targetPort: portId,
      medium: mediumFor(aNode, bNode, pa, pb),
    }).then((e) => { onChanged(); onSelectEdge(e.id); });
    setLinkFrom(null);
  }, [linkFrom, edges, byId, onChanged, onSelectEdge]);

  // --- arrastre genérico de objetos (rack/torre/egreso) para fijar meta.phys ---
  const dragObject = useCallback((n: ApiNode, def: { x: number; y: number }, e: React.PointerEvent) => {
    e.stopPropagation();
    draggedRef.current = false;
    const start = phys(n, def);
    const sx = e.clientX, sy = e.clientY;
    let last = start, moved = false;
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 4) { moved = true; draggedRef.current = true; }
      last = { x: Math.round(start.x + (ev.clientX - sx) / zoom), y: Math.round(start.y + (ev.clientY - sy) / zoom) };
      // feedback inmediato: mutar el DOM del objeto arrastrado
      const el = document.querySelector(`[data-obj="${n.id}"]`) as HTMLElement | null;
      if (el) { el.style.left = last.x + 'px'; el.style.top = last.y + 'px'; }
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (moved) patchMeta(n, { phys: last }); // solo persistir si de verdad se movió
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }, [zoom, phys, patchMeta]);

  // --- arrastre de radio: cambia la altura (mountF) sobre la torre ---
  const dragRadio = useCallback((r: ApiNode, tw: (typeof model.towerViews)[number], e: React.PointerEvent) => {
    e.stopPropagation();
    draggedRef.current = false;
    const span = tw.baseY - tw.apexY;
    const f0 = metaOf(r).mountF ?? 0.6;
    const sy = e.clientY;
    let f = f0, moved = false;
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientY - sy) > 4) { moved = true; draggedRef.current = true; }
      f = Math.max(0.06, Math.min(0.95, f0 - (ev.clientY - sy) / zoom / span));
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (moved) patchMeta(r, { mountF: Math.round(f * 100) / 100 }); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }, [zoom, patchMeta]);

  // --- reordenar equipos en un rack (arrastre vertical → swap de slots) ---
  const dragDevice = useCallback((rackId: number, devId: number, e: React.PointerEvent) => {
    e.stopPropagation();
    draggedRef.current = false;
    let order = membersOf(rackId).map((d) => d.id);
    const startY = e.clientY;
    let base = e.clientY, moved = false;
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientY - startY) > 4) { moved = true; draggedRef.current = true; }
      const dy = ev.clientY - base;
      if (Math.abs(dy) < 24 * zoom) return;
      const i = order.indexOf(devId), j = i + (dy > 0 ? 1 : -1);
      if (j < 0 || j >= order.length) return;
      base = ev.clientY;
      const a = [...order];[a[i], a[j]] = [a[j], a[i]]; order = a;
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (!moved) return; // fue un clic, no un reordenamiento
      // persistir el nuevo orden (slot = índice) para los que cambiaron
      order.forEach((id, idx) => { const nd = byId.get(id); if (nd && metaOf(nd).slot !== idx) void api.updateNode(id, { meta: { ...metaOf(nd), slot: idx } }); });
      onChanged();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }, [membersOf, byId, zoom, onChanged]);

  // --- pan del lienzo ---
  const panStart = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-obj]') || (e.target as HTMLElement).closest('[data-pin]')) return;
    setSel(null);
    // Importante: NO cancelar el enlace en curso al mover el tablero. Así puedes
    // arrastrar hasta la otra torre (aunque esté lejos) sin perder el puerto de origen.
    // Se cancela con la ✕ del aviso o volviendo a pulsar el pin de origen.
    const sx = e.clientX, sy = e.clientY, p0 = pan;
    const move = (ev: PointerEvent) => setPan({ x: p0.x + (ev.clientX - sx), y: p0.y + (ev.clientY - sy) });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }, [pan]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    const d = e.deltaY < 0 ? 1.1 : 0.9;
    setZoom((z) => Math.max(0.32, Math.min(2, Math.round(z * d * 100) / 100)));
  }, []);

  // --- acciones ---
  const addContainer = (type: 'rack' | 'torre') => {
    const def = { x: 340 + (type === 'rack' ? racks.length : towers.length) * 340, y: type === 'rack' ? 120 : 90 };
    void api.createNode({ type, name: type === 'rack' ? `Rack ${String.fromCharCode(65 + racks.length)}` : `Torre ${towers.length + 1}`, posX: def.x, posY: def.y, meta: { phys: def } }).then((n) => { onChanged(); setSel({ kind: type === 'rack' ? 'rack' : 'tower', id: n.id }); });
  };
  const addMember = (type: NodeType) => {
    if (!sel) return;
    const container = byId.get(sel.id); if (!container) return;
    const slot = membersOf(sel.id).length;
    const base = phys(container, { x: 340, y: 120 });
    void api.createNode({ type, name: typeMeta(type).label, posX: base.x, posY: base.y, containerId: sel.id, meta: sel.kind === 'rack' ? { slot } : { mountF: 0.8 - slot * 0.2 } }).then(() => onChanged());
  };
  const togglePower = (n: ApiNode) => { void api.updateNode(n.id, { enabled: !n.enabled }).then(onChanged); };
  const rename = (n: ApiNode) => { const name = window.prompt('Nuevo nombre:', n.name); if (name && name.trim()) void api.updateNode(n.id, { name: name.trim() }).then(onChanged); };
  const del = (n: ApiNode) => { void api.deleteNode(n.id).then(onChanged); };

  // --- cables (desde edges con puertos, ambos extremos dibujables) ---
  const cables = useMemo(() => {
    const out: { edge: ApiEdge; d: string; color: string; dead: boolean; mx: number; my: number; label: string }[] = [];
    for (const e of edges) {
      const a = anchorFor(e.source_id, e.source_port), b = anchorFor(e.target_id, e.target_port);
      if (!a || !b) continue;
      const an = byId.get(e.source_id), bn = byId.get(e.target_id);
      const dead = !!(an && !an.enabled) || !!(bn && !bn.enabled);
      const dx = b.x - a.x;
      const d = `M ${a.x} ${a.y} C ${a.x + dx * 0.45} ${a.y}, ${b.x - dx * 0.45} ${b.y}, ${b.x} ${b.y}`;
      out.push({ edge: e, d, color: dead ? '#39445c' : a.color, dead, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, label: e.label || `${an?.name ?? '?'} → ${bn?.name ?? '?'}` });
    }
    return out;
  }, [edges, anchorFor, byId]);

  const ctxTypes = sel?.kind === 'rack' ? RACK_DEVICE_TYPES : sel?.kind === 'tower' ? TOWER_RADIO_TYPES : [];
  const ctxName = sel ? byId.get(sel.id)?.name : null;

  return (
    <div className="rt-wrap">
      <div className="rt-toolbar">
        <span className="rt-tool-label">Crear</span>
        <button className="rt-btn" onClick={() => addContainer('rack')}><Icon path={ICONS.rack} size={14} strokeWidth={1.9} /> Rack</button>
        <button className="rt-btn" onClick={() => addContainer('torre')}><Icon path={ICONS.torre} size={14} strokeWidth={1.9} /> Torre</button>
        {sel && ctxName && (
          <>
            <div className="rt-divider" />
            <span className="rt-ctx-label">Añadir a {ctxName}</span>
            {ctxTypes.map((t) => (
              <button key={t} className="rt-btn rt-btn-ctx" onClick={() => addMember(t)}>
                <span className="rt-swatch" style={{ background: typeMeta(t).color }} />{typeMeta(t).label}
              </button>
            ))}
          </>
        )}
        <div style={{ flex: 1 }} />
        {linkFrom && <div className="rt-link-hint"><span className="rt-link-dot" />Elige el puerto destino<button onClick={() => setLinkFrom(null)}>✕</button></div>}
        <button className="help-dot" onClick={onHelp} style={{ width: 26, height: 26 }}>!</button>
      </div>

      <div className="rt-canvas" ref={canvasRef} onWheel={onWheel} onPointerDown={panStart}>
        <div className="rt-world" style={{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})` }}>
          {/* celosías de torres (detrás) */}
          <svg className="rt-svg" style={{ zIndex: 1 }}>
            {model.towerViews.map((t) => (
              <g key={t.node.id}>
                <path d={t.rails} stroke="#46536b" strokeWidth={3.5} fill="none" strokeLinecap="round" />
                <path d={t.braces} stroke="#33425f" strokeWidth={1.5} fill="none" strokeLinecap="round" />
              </g>
            ))}
          </svg>

          {/* racks */}
          {model.rackViews.map((rk) => {
            const selRack = sel?.kind === 'rack' && sel.id === rk.node.id;
            return (
              <div key={rk.node.id}>
                <div className="rt-rack-frame" style={{ left: rk.x - 10, top: rk.y - 2, width: G.rackW + 20, height: rk.h, borderColor: selRack ? 'var(--accent)' : '#2a3550', boxShadow: selRack ? '0 0 0 3px var(--accentSoft),0 10px 30px rgba(0,0,0,.5)' : '0 10px 30px rgba(0,0,0,.5)' }} />
                <div data-obj={rk.node.id} className="rt-rack-head" style={{ left: rk.x - 10, top: rk.y - 2, width: G.rackW + 20 }}
                  onPointerDown={(e) => dragObject(rk.node, { x: rk.x, y: rk.y }, e)}
                  onClick={(e) => { e.stopPropagation(); setSel({ kind: 'rack', id: rk.node.id }); clickSelect(rk.node.id); }}>
                  <Icon path={ICONS.rack} size={13} strokeWidth={1.8} />
                  <span className="rt-rack-name" onDoubleClick={() => rename(rk.node)}>{rk.node.name}</span>
                  <span className="rt-count">{rk.devices.length}u</span>
                  <button className="rt-x" data-obj="ctrl" onClick={(e) => { e.stopPropagation(); del(rk.node); }}>✕</button>
                </div>
                {rk.devices.length === 0 && <div className="rt-empty" style={{ left: rk.x + G.pad, top: rk.y + G.headerH + 8, width: G.rackW - G.pad * 2 }}>Rack vacío · selecciónalo y añade equipos</div>}
                {rk.devices.map((d) => {
                  const st = effStatus(d.node, live[d.node.id]);
                  const meta = typeMeta(d.node.type);
                  return (
                    <div key={d.node.id} data-obj={d.node.id} className="rt-device" title={d.node.name} style={{ left: rk.x, top: d.y, width: G.rackW, height: d.h, opacity: d.node.enabled ? 1 : 0.6 }}
                      onPointerDown={(e) => dragDevice(rk.node.id, d.node.id, e)}
                      onClick={(e) => { e.stopPropagation(); clickSelect(d.node.id); }}>
                      <span className="rt-bezel" style={{ background: d.node.enabled ? meta.color : '#2a3346', boxShadow: d.node.enabled ? `0 0 8px ${meta.color}66` : 'none' }} />
                      <span className="rt-dev-ico" style={{ color: meta.color }}><Icon path={ICONS[meta.icon]} size={13} strokeWidth={1.8} /></span>
                      <span className="rt-dev-name" onDoubleClick={(e) => { e.stopPropagation(); rename(d.node); }}>{d.node.name}</span>
                      <span className="node-dot" style={{ width: 7, height: 7, background: HEALTH_HEX[st] }} />
                      <button className="rt-pwr" data-obj="ctrl" title="Encender / apagar" style={{ borderColor: d.node.enabled ? '#33cc7a' : '#54607a', color: d.node.enabled ? '#33cc7a' : '#6b788f' }} onClick={(e) => { e.stopPropagation(); togglePower(d.node); }}>
                        <Icon path="M12 3v9M6.4 6.4a8 8 0 1 0 11.2 0" size={11} strokeWidth={2.2} />
                      </button>
                      <button className="rt-x" data-obj="ctrl" onClick={(e) => { e.stopPropagation(); del(d.node); }}>✕</button>
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* torres */}
          {model.towerViews.map((t) => {
            const selT = sel?.kind === 'tower' && sel.id === t.node.id;
            return (
              <div key={t.node.id}>
                <div className="rt-hit" style={{ left: t.x, top: t.y, width: G.towerW, height: t.twH }} onClick={(e) => { e.stopPropagation(); setSel({ kind: 'tower', id: t.node.id }); clickSelect(t.node.id); }} />
                <div data-obj={t.node.id} className="rt-tower-head" style={{ left: t.x - 4, top: t.y - 24, borderColor: selT ? 'var(--accent)' : '#2a3550', background: selT ? 'var(--accentSoft)' : 'rgba(255,255,255,.04)' }}
                  onPointerDown={(e) => dragObject(t.node, { x: t.x, y: t.y }, e)}
                  onClick={(e) => { e.stopPropagation(); setSel({ kind: 'tower', id: t.node.id }); clickSelect(t.node.id); }}>
                  <Icon path={ICONS.torre} size={12} strokeWidth={1.8} />
                  <span className="rt-rack-name" onDoubleClick={() => rename(t.node)}>{t.node.name}</span>
                  <span className="rt-count">{t.radios.length}</span>
                  <button className="rt-x" data-obj="ctrl" onClick={(e) => { e.stopPropagation(); del(t.node); }}>✕</button>
                </div>
                {t.radios.map((r) => {
                  const st = effStatus(r.node, live[r.node.id]);
                  const meta = typeMeta(r.node.type);
                  return (
                    <div key={r.node.id}>
                      <div className="rt-mount" style={{ left: r.mountLeft, top: r.y + 18, width: 14 }} />
                      <div data-obj={r.node.id} className="rt-radio" title={r.node.name} style={{ left: r.x, top: r.y, borderColor: r.node.enabled ? `${meta.color}66` : '#222b3d', opacity: r.node.enabled ? 1 : 0.65 }}
                        onPointerDown={(e) => dragRadio(r.node, t, e)}
                        onClick={(e) => { e.stopPropagation(); clickSelect(r.node.id); }}>
                        <span className="rt-radio-ico" style={{ color: r.node.enabled ? meta.color : '#556' }}><Icon path={ICONS[meta.icon]} size={14} strokeWidth={1.7} /></span>
                        <div style={{ minWidth: 0 }}>
                          <div className="rt-radio-name" onDoubleClick={(e) => { e.stopPropagation(); rename(r.node); }}>{r.node.name}</div>
                          <div className="rt-radio-sub">PoE ↓</div>
                        </div>
                        <span className="node-dot" style={{ width: 6, height: 6, background: HEALTH_HEX[st] }} />
                        <button className="rt-pwr" data-obj="ctrl" style={{ borderColor: r.node.enabled ? '#33cc7a' : '#54607a', color: r.node.enabled ? '#33cc7a' : '#6b788f' }} onClick={(e) => { e.stopPropagation(); togglePower(r.node); }}>
                          <Icon path="M12 3v9M6.4 6.4a8 8 0 1 0 11.2 0" size={10} strokeWidth={2.4} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* egresos */}
          {model.egViews.map((e) => {
            const meta = typeMeta(e.node.type);
            return (
              <div key={e.node.id} data-obj={e.node.id} className="rt-egress" style={{ left: e.x, top: e.y, width: G.egW, height: G.egH }}
                onPointerDown={(ev) => dragObject(e.node, { x: e.x, y: e.y }, ev)}
                onClick={(ev) => { ev.stopPropagation(); clickSelect(e.node.id); }}>
                <span className="rt-eg-ico" style={{ color: meta.color }}><Icon path={ICONS[meta.icon]} size={16} strokeWidth={1.8} /></span>
                <div style={{ minWidth: 0 }}>
                  <div className="rt-eg-name">{e.node.name}</div>
                  <div className="rt-eg-sub">{e.node.ip || 'egreso'}</div>
                </div>
              </div>
            );
          })}

          {/* cables */}
          <svg className="rt-svg" style={{ zIndex: 5 }}>
            {cables.map((c) => (
              <g key={c.edge.id}>
                <path d={c.d} fill="none" stroke={c.color} strokeWidth={3.5} strokeLinecap="round" opacity={0.5} />
                <path d={c.d} fill="none" stroke={c.color} strokeWidth={2} strokeLinecap="round" strokeDasharray="5 6" style={{ animation: c.dead ? 'none' : 'dashflow .7s linear infinite', opacity: c.dead ? 0.3 : 1 }} />
              </g>
            ))}
          </svg>

          {/* pines de puertos (interactivos, encima de los cables) */}
          {model.rackViews.flatMap((rk) => rk.devices.flatMap((d) => d.ports.map((p) => {
            const pid = `${d.node.id}:${p.port.id}`;
            const active = linkFrom?.nodeId === d.node.id && linkFrom?.portId === p.port.id;
            const col = portColor(p.port.kind);
            return (
              <div key={pid} data-pin="1" className="rt-pin" style={{ left: p.x - G.jackW / 2, top: p.y - G.jackH / 2, width: G.jackW, height: G.jackH, borderColor: active ? 'var(--accent)' : col, boxShadow: active ? '0 0 0 3px var(--accentSoft)' : `0 0 5px ${col}88` }}
                title={`${d.node.name}:${p.port.label}`}
                onClick={(e) => { e.stopPropagation(); clickPort(d.node.id, p.port.id); }}>
                <span className="rt-pin-dot" style={{ background: d.node.enabled ? col : '#2b3444' }} />
                <span className="rt-pin-tag">{p.port.tag}</span>
              </div>
            );
          })))}
          {model.towerViews.flatMap((t) => t.radios.flatMap((r) => {
            const poeActive = linkFrom?.nodeId === r.node.id && linkFrom?.portId === 'poe';
            const airActive = linkFrom?.nodeId === r.node.id && linkFrom?.portId === 'air';
            const poe = model.anchors.get(`${r.node.id}:poe`)!;
            const air = model.anchors.get(`${r.node.id}:air`)!;
            return [
              <div key={`${r.node.id}:poe`} data-pin="1" className="rt-pin rt-pin-poe" style={{ left: poe.x - 9, top: poe.y - 7, borderColor: poeActive ? 'var(--accent)' : '#57c7d4', boxShadow: poeActive ? '0 0 0 3px var(--accentSoft)' : '0 0 5px #57c7d488' }}
                title={`${r.node.name}: PoE`} onClick={(e) => { e.stopPropagation(); clickPort(r.node.id, 'poe'); }}>
                <span className="rt-pin-dot" style={{ background: r.node.enabled ? '#57c7d4' : '#2b3444' }} />
              </div>,
              <div key={`${r.node.id}:air`} data-pin="1" className="rt-pin rt-pin-air" style={{ left: air.x - 9, top: air.y - 9, borderColor: airActive ? 'var(--accent)' : '#8b5bff', boxShadow: airActive ? '0 0 0 3px var(--accentSoft)' : '0 0 6px #8b5bff88' }}
                title={`${r.node.name}: enlace de aire (RF) — conéctalo al radio de otra torre`} onClick={(e) => { e.stopPropagation(); clickPort(r.node.id, 'air'); }}>
                <span className="rt-pin-dot" style={{ background: r.node.enabled ? '#8b5bff' : '#2b3444' }} />
              </div>,
            ];
          }))}
          {model.egViews.map((e) => {
            const pid = `${e.node.id}:_`;
            const a = model.anchors.get(pid)!;
            const active = linkFrom?.nodeId === e.node.id;
            return (
              <div key={pid} data-pin="1" className="rt-pin rt-pin-eg" style={{ left: a.x - 9, top: a.y - 9, borderColor: active ? 'var(--accent)' : a.color, boxShadow: active ? '0 0 0 3px var(--accentSoft)' : `0 0 6px ${a.color}66` }}
                title={`${e.node.name}`} onClick={(ev) => { ev.stopPropagation(); clickPort(e.node.id, '_'); }}>
                <span className="rt-pin-dot" style={{ background: a.color }} />
              </div>
            );
          })}

          {/* etiquetas de cable (clic para borrar) */}
          {cables.map((c) => (
            <div key={c.edge.id} className="rt-cable-label" style={{ left: c.mx, top: c.my - 9, borderColor: c.color, outline: c.edge.id === selectedEdgeId ? '2px solid var(--accent)' : 'none' }}
              title="Clic para ver el enlace (borrarlo desde su panel)" onClick={(e) => { e.stopPropagation(); onSelectEdge(c.edge.id); }}>{c.label}</div>
          ))}
        </div>

        {/* controles de zoom */}
        <div className="rt-zoom">
          <button onClick={() => setZoom((z) => Math.min(2, Math.round(z * 1.15 * 100) / 100))}>+</button>
          <button onClick={() => setZoom((z) => Math.max(0.32, Math.round(z * 0.87 * 100) / 100))}>−</button>
          <button title="Reencuadrar" onClick={() => { setPan({ x: 40, y: 20 }); setZoom(0.85); }}>
            <Icon path="M3 9V5a2 2 0 0 1 2-2h4M15 3h4a2 2 0 0 1 2 2v4M21 15v4a2 2 0 0 1-2 2h-4M9 21H5a2 2 0 0 1-2-2v-4" size={15} strokeWidth={2} />
          </button>
        </div>
        <div className="rt-zoom-pct">zoom {Math.round(zoom * 100)}%</div>

        {racks.length === 0 && towers.length === 0 && (
          <div className="rt-empty-state">
            <div style={{ fontSize: 34 }}>🗄️</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>Aún no hay racks ni torres</div>
            <div style={{ fontSize: 12, maxWidth: 320, textAlign: 'center' }}>Crea un rack o una torre desde la barra de arriba, selecciónalo y añade sus equipos. Todo se sincroniza con la topología y el mapa.</div>
          </div>
        )}
      </div>
    </div>
  );
}
