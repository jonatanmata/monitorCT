import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { ApiNode, ApiEdge, LiveNode } from '../types';
import { ICONS, TYPE_META } from '../ui/meta';
import { api } from '../api';

const HEALTH_HEX: Record<string, string> = { up: '#33cc7a', warning: '#f5b13d', down: '#f0556b', unknown: '#6b788f' };

const STYLE_MAP: Record<string, string> = { dark: 'dataviz-dark', satellite: 'hybrid', streets: 'streets-v2' };
function styleUrl(key: string, style: string): string {
  return `https://api.maptiler.com/maps/${STYLE_MAP[style] ?? 'dataviz-dark'}/style.json?key=${encodeURIComponent(key)}`;
}

interface Props {
  nodes: ApiNode[];
  edges: ApiEdge[];
  live: Record<number, LiveNode>;
  maptilerKey: string;
  mapStyle: string;
  onSelectNode: (id: number) => void;
  onSelectEdge: (id: number) => void;
  onChanged: () => void;
  onHelp: () => void;
}

/** Estado efectivo de un nodo para el color (monitor siempre up; bwNear = warning). */
function effStatus(node: ApiNode, live: LiveNode | undefined): string {
  if (node.type === 'monitor') return 'up';
  const s = live?.status ?? 'unknown';
  if (s === 'up' && live?.bwNear) return 'warning';
  return s;
}

function buildMarkerEl(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'geo-marker';
  el.innerHTML = `<span class="geo-ring"></span><span class="geo-ico"></span><span class="geo-dot"></span><span class="geo-name"></span>`;
  return el;
}
function paintMarker(el: HTMLElement, node: ApiNode, live: LiveNode | undefined): void {
  const meta = TYPE_META[node.type] ?? TYPE_META.cliente;
  const status = effStatus(node, live);
  const color = HEALTH_HEX[status];
  const ico = el.querySelector('.geo-ico') as HTMLElement;
  const dot = el.querySelector('.geo-dot') as HTMLElement;
  const ring = el.querySelector('.geo-ring') as HTMLElement;
  const nameEl = el.querySelector('.geo-name') as HTMLElement;
  ico.style.color = meta.color;
  ico.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[meta.icon]}"/></svg>`;
  dot.style.background = color;
  nameEl.textContent = node.name;
  const down = status === 'down';
  ring.style.boxShadow = status === 'unknown' ? 'none' : `0 0 0 2px ${color}`;
  ring.style.animation = down ? 'pulse 1.4s infinite' : 'none';
}

export default function GeoMap({ nodes, edges, live, maptilerKey, mapStyle, onSelectNode, onSelectEdge, onChanged, onHelp }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Map<number, { marker: maplibregl.Marker; el: HTMLElement }>>(new Map());
  const loadedRef = useRef(false);
  // refs para leer datos frescos dentro de handlers de MapLibre
  const dataRef = useRef({ nodes, edges, live });
  dataRef.current = { nodes, edges, live };
  const cbRef = useRef({ onSelectNode, onSelectEdge, onChanged });
  cbRef.current = { onSelectNode, onSelectEdge, onChanged };
  const [ready, setReady] = useState(false);

  // --- crear el mapa una vez ---
  useEffect(() => {
    if (!maptilerKey || !containerRef.current) return;
    const placed = nodes.filter((n) => n.lat != null && n.lng != null);
    const center: [number, number] = placed.length
      ? [placed.reduce((a, n) => a + n.lng!, 0) / placed.length, placed.reduce((a, n) => a + n.lat!, 0) / placed.length]
      : [-74.5, 4.6]; // Colombia por defecto
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleUrl(maptilerKey, mapStyle),
      center,
      zoom: placed.length ? 12 : 6,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');
    mapRef.current = map;

    map.on('load', () => {
      loadedRef.current = true;
      map.addSource('edges', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'edges-base', type: 'line', source: 'edges', paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.5 } });
      map.addLayer({ id: 'edges-flow', type: 'line', source: 'edges', paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [0, 4, 3] } });
      map.on('click', 'edges-base', (e) => {
        const id = e.features?.[0]?.properties?.id;
        if (id != null) cbRef.current.onSelectEdge(Number(id));
      });
      map.on('mouseenter', 'edges-base', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'edges-base', () => { map.getCanvas().style.cursor = ''; });
      setReady(true);
    });

    // animación de flujo en las líneas (dash cíclico)
    const dashSeq = [[0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5]];
    let step = 0;
    const anim = setInterval(() => {
      if (!loadedRef.current || !map.getLayer('edges-flow')) return;
      step = (step + 1) % dashSeq.length;
      try { map.setPaintProperty('edges-flow', 'line-dasharray', dashSeq[step]); } catch { /* estilo recargando */ }
    }, 90);

    return () => { clearInterval(anim); map.remove(); mapRef.current = null; loadedRef.current = false; setReady(false); };
    // Recrear el mapa si cambia la key o el estilo
  }, [maptilerKey, mapStyle]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- reconciliar markers cuando cambian los nodos (posición/alta/baja) ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const markers = markersRef.current;
    const seen = new Set<number>();
    for (const n of nodes) {
      if (n.lat == null || n.lng == null) continue;
      seen.add(n.id);
      let entry = markers.get(n.id);
      if (!entry) {
        const el = buildMarkerEl();
        el.addEventListener('click', (ev) => { ev.stopPropagation(); cbRef.current.onSelectNode(n.id); });
        const marker = new maplibregl.Marker({ element: el, draggable: n.type !== 'monitor' }).setLngLat([n.lng, n.lat]).addTo(map);
        marker.on('dragend', () => {
          const ll = marker.getLngLat();
          void api.updateNode(n.id, { lat: ll.lat, lng: ll.lng }).then(() => cbRef.current.onChanged());
        });
        entry = { marker, el };
        markers.set(n.id, entry);
      } else {
        entry.marker.setLngLat([n.lng, n.lat]);
      }
      paintMarker(entry.el, n, dataRef.current.live[n.id]);
    }
    for (const [id, entry] of markers) if (!seen.has(id)) { entry.marker.remove(); markers.delete(id); }
  }, [nodes, ready]);

  // --- actualizar visual de markers + líneas cuando cambia el estado en vivo ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const n of nodes) {
      const entry = markersRef.current.get(n.id);
      if (entry) paintMarker(entry.el, n, live[n.id]);
    }
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const features = edges.flatMap((e) => {
      const s = byId.get(e.source_id), t = byId.get(e.target_id);
      if (!s || !t || s.lat == null || s.lng == null || t.lat == null || t.lng == null) return [];
      const rank = { down: 3, warning: 2, unknown: 1, up: 0 } as Record<string, number>;
      const a = effStatus(s, live[s.id]), b = effStatus(t, live[t.id]);
      const health = rank[a] >= rank[b] ? a : b;
      return [{ type: 'Feature' as const, properties: { id: e.id, color: HEALTH_HEX[health] }, geometry: { type: 'LineString' as const, coordinates: [[s.lng, s.lat], [t.lng, t.lat]] } }];
    });
    const src = map.getSource('edges') as maplibregl.GeoJSONSource | undefined;
    src?.setData({ type: 'FeatureCollection', features });
  }, [live, nodes, edges, ready]);

  const unplaced = nodes.filter((n) => n.lat == null || n.lng == null);

  const placeAtCenter = (n: ApiNode) => {
    const c = mapRef.current?.getCenter();
    if (!c) return;
    void api.updateNode(n.id, { lat: c.lat, lng: c.lng }).then(() => cbRef.current.onChanged());
  };

  if (!maptilerKey) {
    return (
      <div className="section-scroll">
        <div className="card" style={{ maxWidth: 560, margin: '40px auto' }}>
          <h3>Configura el mapa</h3>
          <p className="card-sub">El modo mapa usa MapTiler (gratis). Crea una cuenta, copia tu <b>API key</b> y pégala en <b>Ajustes → Mapa</b>.</p>
          <a className="btn primary" href="https://cloud.maptiler.com/account/keys/" target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>Obtener API key gratis</a>
        </div>
      </div>
    );
  }

  return (
    <div className="topo-wrap">
      <div ref={containerRef} className="geo-canvas" />
      {unplaced.length > 0 && (
        <div className="geo-unplaced">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span className="palette-title">Sin ubicar ({unplaced.length})</span>
            <button className="help-dot" style={{ width: 16, height: 16, fontSize: 10 }} onClick={onHelp}>!</button>
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--muted)', marginBottom: 8 }}>Clic para colocar en el centro del mapa; luego arrastra el marcador.</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto' }}>
            {unplaced.map((n) => {
              const meta = TYPE_META[n.type] ?? TYPE_META.cliente;
              return (
                <button key={n.id} className="palette-btn" onClick={() => placeAtCenter(n)} title={`Colocar ${n.name}`}>
                  <span className="palette-ico" style={{ color: meta.color, width: 22, height: 22 }} dangerouslySetInnerHTML={{ __html: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[meta.icon]}"/></svg>` }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
