import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { ApiNode, ApiEdge, LiveNode } from '../types';
import { CONTAINER_TYPES } from '../types';
import { ICONS, typeMeta } from '../ui/meta';
import { api } from '../api';

/** Coordenada efectiva: propia, o heredada del contenedor (con leve dispersión para no solaparse). */
function computeEffCoords(nodes: ApiNode[]): Map<number, { lat: number; lng: number; inherited: boolean }> {
  const out = new Map<number, { lat: number; lng: number; inherited: boolean }>();
  const containers = new Map<number, { lat: number; lng: number }>();
  for (const n of nodes) if (CONTAINER_TYPES.includes(n.type) && n.lat != null && n.lng != null) containers.set(n.id, { lat: n.lat, lng: n.lng });
  const idxInContainer = new Map<number, number>();
  for (const n of nodes) {
    if (n.lat != null && n.lng != null) { out.set(n.id, { lat: n.lat, lng: n.lng, inherited: false }); continue; }
    if (n.containerId != null) {
      const c = containers.get(n.containerId);
      if (c) {
        const i = idxInContainer.get(n.containerId) ?? 0;
        idxInContainer.set(n.containerId, i + 1);
        const ang = i * 0.9, r = 0.0004 * (1 + Math.floor(i / 6));
        out.set(n.id, { lat: c.lat + Math.sin(ang) * r, lng: c.lng + Math.cos(ang) * r, inherited: true });
      }
    }
  }
  return out;
}

const HEALTH_HEX: Record<string, string> = { up: '#33cc7a', warning: '#f5b13d', down: '#f0556b', unknown: '#6b788f' };

/**
 * Devuelve el estilo para MapLibre según el proveedor detectado por la key:
 * - Mapbox (token que empieza por 'pk.'/'sk.'): tiles raster de la API de estilos de Mapbox.
 * - MapTiler (el resto): style.json vectorial nativo de MapLibre.
 * MapLibre acepta tanto una URL (string) como un objeto de estilo.
 */
function buildStyle(key: string, style: string): string | maplibregl.StyleSpecification {
  const isMapbox = /^(pk|sk)\./.test(key.trim());
  if (isMapbox) {
    const id = ({ dark: 'dark-v11', satellite: 'satellite-streets-v12', streets: 'streets-v12' } as Record<string, string>)[style] ?? 'dark-v11';
    return {
      version: 8,
      sources: { base: { type: 'raster', tiles: [`https://api.mapbox.com/styles/v1/mapbox/${id}/tiles/512/{z}/{x}/{y}@2x?access_token=${encodeURIComponent(key)}`], tileSize: 512, attribution: '© Mapbox © OpenStreetMap' } },
      layers: [{ id: 'base', type: 'raster', source: 'base' }],
    };
  }
  const id = ({ dark: 'dataviz-dark', satellite: 'hybrid', streets: 'streets-v2' } as Record<string, string>)[style] ?? 'dataviz-dark';
  return `https://api.maptiler.com/maps/${id}/style.json?key=${encodeURIComponent(key)}`;
}

interface Props {
  nodes: ApiNode[];
  edges: ApiEdge[];
  live: Record<number, LiveNode>;
  maptilerKey: string;
  mapStyle: string;
  selectedNodeId: number | null;
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
  const meta = typeMeta(node.type);
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

export default function GeoMap({ nodes, edges, live, maptilerKey, mapStyle, selectedNodeId, onSelectNode, onSelectEdge, onChanged, onHelp }: Props) {
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
      style: buildStyle(maptilerKey, mapStyle),
      center,
      zoom: placed.length ? 12 : 6,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');
    // Control «mi ubicación» (botón para centrar en el dispositivo).
    const geolocate = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false, showUserLocation: true });
    map.addControl(geolocate, 'bottom-left');
    mapRef.current = map;

    map.on('load', () => {
      loadedRef.current = true;
      map.addSource('edges', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'edges-base', type: 'line', source: 'edges', paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.5 } });
      map.addLayer({ id: 'edges-flow', type: 'line', source: 'edges', paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [0, 4, 3] } });
      // Camino PON resaltado (OLT→ONU) cuando se selecciona una ONU.
      map.addSource('pon-path', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'pon-path', type: 'line', source: 'pon-path', paint: { 'line-color': '#8b5bff', 'line-width': 5, 'line-opacity': 0.85, 'line-blur': 1 } }, 'edges-flow');
      map.on('click', 'edges-base', (e) => {
        const id = e.features?.[0]?.properties?.id;
        if (id != null) cbRef.current.onSelectEdge(Number(id));
      });
      map.on('mouseenter', 'edges-base', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'edges-base', () => { map.getCanvas().style.cursor = ''; });
      map.resize(); // el contenedor pudo iniciar sin tamaño (lazy mount / flex)
      // Sin nodos ubicados: centrar en la ubicación del dispositivo (si el navegador la da).
      if (!placed.length && navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 14 }),
          () => { /* permiso denegado: se queda en el centro por defecto */ },
          { enableHighAccuracy: true, timeout: 8000 },
        );
      }
      setReady(true);
    });

    // Reajustar el lienzo cuando el contenedor cambia de tamaño (colapsar sidebar, etc.).
    const ro = new ResizeObserver(() => map.resize());
    if (containerRef.current) ro.observe(containerRef.current);

    // animación de flujo en las líneas (dash cíclico)
    const dashSeq = [[0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5]];
    let step = 0;
    const anim = setInterval(() => {
      if (!loadedRef.current || !map.getLayer('edges-flow')) return;
      step = (step + 1) % dashSeq.length;
      try { map.setPaintProperty('edges-flow', 'line-dasharray', dashSeq[step]); } catch { /* estilo recargando */ }
    }, 90);

    return () => { clearInterval(anim); ro.disconnect(); map.remove(); mapRef.current = null; loadedRef.current = false; setReady(false); };
    // Recrear el mapa si cambia la key o el estilo
  }, [maptilerKey, mapStyle]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- reconciliar markers cuando cambian los nodos (posición/alta/baja) ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const markers = markersRef.current;
    const eff = computeEffCoords(nodes);
    const seen = new Set<number>();
    for (const n of nodes) {
      const c = eff.get(n.id);
      if (!c) continue;
      seen.add(n.id);
      let entry = markers.get(n.id);
      if (!entry) {
        const el = buildMarkerEl();
        const marker = new maplibregl.Marker({ element: el, draggable: n.type !== 'monitor' }).setLngLat([c.lng, c.lat]).addTo(map);
        let draggedAt = 0;
        marker.on('dragstart', () => { draggedAt = Date.now(); el.style.cursor = 'grabbing'; });
        marker.on('dragend', () => {
          draggedAt = Date.now(); el.style.cursor = '';
          const ll = marker.getLngLat();
          void api.updateNode(n.id, { lat: ll.lat, lng: ll.lng }).then(() => cbRef.current.onChanged());
        });
        // Clic limpio (no fue arrastre) abre el panel del equipo.
        el.addEventListener('click', (ev) => { ev.stopPropagation(); if (Date.now() - draggedAt < 250) return; cbRef.current.onSelectNode(n.id); });
        entry = { marker, el };
        markers.set(n.id, entry);
      } else {
        // No reposicionar mientras se arrastra este marcador (evita pelear con el drag).
        if (!entry.marker.isDraggable() || !(entry.el.style.cursor === 'grabbing')) entry.marker.setLngLat([c.lng, c.lat]);
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
    const eff = computeEffCoords(nodes);
    const features = edges.flatMap((e) => {
      const s = byId.get(e.source_id), t = byId.get(e.target_id);
      const sc = eff.get(e.source_id), tc = eff.get(e.target_id);
      if (!s || !t || !sc || !tc) return [];
      const rank = { down: 3, warning: 2, unknown: 1, up: 0 } as Record<string, number>;
      const a = effStatus(s, live[s.id]), b = effStatus(t, live[t.id]);
      const health = rank[a] >= rank[b] ? a : b;
      return [{ type: 'Feature' as const, properties: { id: e.id, color: HEALTH_HEX[health] }, geometry: { type: 'LineString' as const, coordinates: [[sc.lng, sc.lat], [tc.lng, tc.lat]] } }];
    });
    const src = map.getSource('edges') as maplibregl.GeoJSONSource | undefined;
    src?.setData({ type: 'FeatureCollection', features });
  }, [live, nodes, edges, ready]);

  // Resaltar el camino PON OLT→ONU al seleccionar una ONU.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource('pon-path') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    const sel = nodes.find((n) => n.id === selectedNodeId);
    if (!sel || sel.type !== 'onu') { src.setData({ type: 'FeatureCollection', features: [] }); return; }
    let alive = true;
    api.ponBudget(sel.id).then((b) => {
      if (!alive) return;
      const eff = computeEffCoords(nodes);
      const coords = b.path.map((id) => eff.get(id)).filter(Boolean).map((c) => [c!.lng, c!.lat]);
      src.setData(coords.length >= 2
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] }
        : { type: 'FeatureCollection', features: [] });
    }).catch(() => {});
    return () => { alive = false; };
  }, [selectedNodeId, nodes, ready]);

  const effAll = computeEffCoords(nodes);
  const unplaced = nodes.filter((n) => !effAll.has(n.id));

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
          <p className="card-sub">El modo mapa acepta una <b>API key de MapTiler</b> (gratis, recomendado) o un <b>token de Mapbox</b> (empieza por <code>pk.</code>). Pégala en <b>Ajustes → Mapa</b>.</p>
          <a className="btn primary" href="https://cloud.maptiler.com/account/keys/" target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>Obtener API key de MapTiler</a>
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
              const meta = typeMeta(n.type);
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
