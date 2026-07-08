import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { ApiNode, ApiEdge, LiveNode } from '../types';
import { CONTAINER_TYPES } from '../types';
import { ICONS, typeMeta } from '../ui/meta';
import { api } from '../api';

/**
 * Coordenada efectiva: propia, o heredada del contenedor. Los miembros sin
 * ubicación propia colapsan EXACTAMENTE al punto del contenedor (inherited:true)
 * y se dibujan apilados verticalmente dentro de su torre/rack, no dispersos.
 */
function computeEffCoords(nodes: ApiNode[]): Map<number, { lat: number; lng: number; inherited: boolean }> {
  const out = new Map<number, { lat: number; lng: number; inherited: boolean }>();
  const containers = new Map<number, { lat: number; lng: number }>();
  for (const n of nodes) if (CONTAINER_TYPES.includes(n.type) && n.lat != null && n.lng != null) containers.set(n.id, { lat: n.lat, lng: n.lng });
  for (const n of nodes) {
    if (n.lat != null && n.lng != null) { out.set(n.id, { lat: n.lat, lng: n.lng, inherited: false }); continue; }
    if (n.containerId != null) {
      const c = containers.get(n.containerId);
      if (c) out.set(n.id, { lat: c.lat, lng: c.lng, inherited: true });
    }
  }
  return out;
}

const HEALTH_HEX: Record<string, string> = { up: '#33cc7a', warning: '#f5b13d', down: '#f0556b', unknown: '#6b788f' };

/** Distancia geodésica en metros entre dos coordenadas (Haversine). */
function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad, dLng = (bLng - aLng) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
/** Formatea metros a «340 m» / «1.24 km». */
function fmtDist(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

/**
 * Devuelve el estilo para MapLibre según el proveedor detectado por la key:
 * - Mapbox (token que empieza por 'pk.'/'sk.'): tiles raster de la API de estilos de Mapbox.
 * - MapTiler (el resto): style.json vectorial nativo de MapLibre.
 * MapLibre acepta tanto una URL (string) como un objeto de estilo.
 */
function buildStyle(key: string, style: string, theme: 'dark' | 'light'): string | maplibregl.StyleSpecification {
  const isMapbox = /^(pk|sk)\./.test(key.trim());
  // El mapa base sigue el tema de la app (claro/oscuro), salvo satélite (siempre foto).
  const base = style === 'satellite' ? 'satellite' : theme;
  if (isMapbox) {
    const id = ({ dark: 'dark-v11', light: 'light-v11', satellite: 'satellite-streets-v12' } as Record<string, string>)[base] ?? 'dark-v11';
    return {
      version: 8,
      sources: { base: { type: 'raster', tiles: [`https://api.mapbox.com/styles/v1/mapbox/${id}/tiles/512/{z}/{x}/{y}@2x?access_token=${encodeURIComponent(key)}`], tileSize: 512, attribution: '© Mapbox © OpenStreetMap' } },
      layers: [{ id: 'base', type: 'raster', source: 'base' }],
    };
  }
  const id = ({ dark: 'dataviz-dark', light: 'dataviz', satellite: 'hybrid' } as Record<string, string>)[base] ?? 'dataviz-dark';
  return `https://api.maptiler.com/maps/${id}/style.json?key=${encodeURIComponent(key)}`;
}

interface Props {
  nodes: ApiNode[];
  edges: ApiEdge[];
  live: Record<number, LiveNode>;
  maptilerKey: string;
  mapStyle: string;
  theme: 'dark' | 'light';
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

const STATUS_RANK: Record<string, number> = { down: 3, warning: 2, unknown: 1, up: 0 };

/** Badge de un contenedor (rack/torre): nº de miembros + peor estado. null si no es contenedor. */
function badgeFor(node: ApiNode, nodes: ApiNode[], live: Record<number, LiveNode>): { count: number; worst: string } | null {
  if (!CONTAINER_TYPES.includes(node.type)) return null;
  const members = nodes.filter((m) => m.containerId === node.id);
  let worst = 'unknown';
  for (const m of members) { const s = effStatus(m, live[m.id]); if ((STATUS_RANK[s] ?? 0) >= (STATUS_RANK[worst] ?? 0)) worst = s; }
  return { count: members.length, worst };
}

function buildMarkerEl(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'geo-marker';
  el.innerHTML = `<span class="geo-ring"></span><span class="geo-ico"></span><span class="geo-dot"></span><span class="geo-name"></span><span class="geo-badge"></span>`;
  return el;
}
function paintMarker(el: HTMLElement, node: ApiNode, live: LiveNode | undefined, badge?: { count: number; worst: string } | null): void {
  const meta = typeMeta(node.type);
  const status = effStatus(node, live);
  const color = HEALTH_HEX[status];
  const ico = el.querySelector('.geo-ico') as HTMLElement;
  const dot = el.querySelector('.geo-dot') as HTMLElement;
  const ring = el.querySelector('.geo-ring') as HTMLElement;
  const nameEl = el.querySelector('.geo-name') as HTMLElement;
  const badgeEl = el.querySelector('.geo-badge') as HTMLElement;
  ico.style.color = meta.color;
  ico.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[meta.icon]}"/></svg>`;
  dot.style.background = color;
  nameEl.textContent = node.name;
  const down = status === 'down';
  ring.style.boxShadow = status === 'unknown' ? 'none' : `0 0 0 2px ${color}`;
  ring.style.animation = down ? 'pulse 1.4s infinite' : 'none';
  if (badge) {
    // Contenedor: el dot muestra el peor estado de los miembros; el badge, cuántos hay.
    const bc = HEALTH_HEX[badge.worst] ?? HEALTH_HEX.unknown;
    dot.style.background = bc;
    badgeEl.textContent = String(badge.count);
    badgeEl.style.display = badge.count > 0 ? 'flex' : 'none';
    badgeEl.style.background = bc;
  } else {
    badgeEl.style.display = 'none';
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

/** Marcador compuesto de torre/rack: apila verticalmente sus equipos sobre la base geográfica. */
function buildTowerEl(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'geo-tower';
  return el;
}
/** Ordena los miembros para el apilado (radios por altura de montaje; equipos por slot). */
function orderMembers(members: ApiNode[]): ApiNode[] {
  const meta = (n: ApiNode) => (n.meta ?? {}) as { mountF?: number; slot?: number };
  return [...members].sort((a, b) => {
    const ma = meta(a), mb = meta(b);
    if (ma.mountF != null || mb.mountF != null) return (mb.mountF ?? 0) - (ma.mountF ?? 0); // más alto arriba
    return (ma.slot ?? 999) - (mb.slot ?? 999);
  });
}
function paintTower(el: HTMLElement, container: ApiNode, members: ApiNode[], live: Record<number, LiveNode>): void {
  const cmeta = typeMeta(container.type);
  let worst = 'unknown';
  for (const m of members) { const s = m.type === 'monitor' ? 'up' : effStatus(m, live[m.id]); if ((STATUS_RANK[s] ?? 0) >= (STATUS_RANK[worst] ?? 0)) worst = s; }
  const items = orderMembers(members).map((m) => {
    const mm = typeMeta(m.type);
    const st = m.type === 'monitor' ? 'up' : effStatus(m, live[m.id]);
    const down = st === 'down' ? 'geo-tower-dot-down' : '';
    return `<div class="geo-tower-item" data-mid="${m.id}"><span class="geo-tower-bar" style="background:${mm.color}"></span><span class="geo-tower-name">${escapeHtml(m.name)}</span><span class="geo-tower-dot ${down}" style="background:${HEALTH_HEX[st]}"></span></div>`;
  }).join('');
  el.innerHTML =
    `<div class="geo-tower-stack">${items || '<div class="geo-tower-empty">torre vacía</div>'}</div>` +
    `<div class="geo-tower-mast"></div>` +
    `<div class="geo-tower-base" data-mid="" style="border-color:${HEALTH_HEX[worst]}">` +
      `<span class="geo-tower-ico" style="color:${cmeta.color}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[cmeta.icon]}"/></svg></span>` +
      `<span class="geo-tower-basename">${escapeHtml(container.name)}</span>` +
      `<span class="geo-tower-dot" style="background:${HEALTH_HEX[worst]}"></span>` +
    `</div>`;
}

export default function GeoMap({ nodes, edges, live, maptilerKey, mapStyle, theme, selectedNodeId, onSelectNode, onSelectEdge, onChanged, onHelp }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Map<number, { marker: maplibregl.Marker; el: HTMLElement; kind: 'tower' | 'node' }>>(new Map());
  const clusterMarkersRef = useRef<Map<number, { marker: maplibregl.Marker; el: HTMLElement }>>(new Map());
  const edgeLabelsRef = useRef<Map<number, { marker: maplibregl.Marker; el: HTMLElement }>>(new Map());
  const loadedRef = useRef(false);
  // refs para leer datos frescos dentro de handlers de MapLibre
  const dataRef = useRef({ nodes, edges, live });
  dataRef.current = { nodes, edges, live };
  const cbRef = useRef({ onSelectNode, onSelectEdge, onChanged });
  cbRef.current = { onSelectNode, onSelectEdge, onChanged };
  const [ready, setReady] = useState(false);

  // --- agrupar equipos cercanos en píxeles (clustering por zoom) ---
  // Al alejar, los markers que quedan a < CLUSTER_PX se reúnen en una burbuja con el nº total.
  const recluster = useCallback(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const { nodes, live, edges } = dataRef.current;
    const eff = computeEffCoords(nodes);
    // Los miembros apilados en una torre no cuentan como puntos sueltos (ya van dentro de ella).
    const pts = nodes.map((n) => { const c = eff.get(n.id); return c && !c.inherited ? { n, c, p: map.project([c.lng, c.lat]) } : null; }).filter(Boolean) as { n: ApiNode; c: { lat: number; lng: number }; p: { x: number; y: number } }[];

    const CLUSTER_PX = 46;
    const used = new Set<number>();
    const clusteredIds = new Set<number>();
    const bubbles: { key: number; lng: number; lat: number; count: number; worst: string }[] = [];
    for (let i = 0; i < pts.length; i++) {
      if (used.has(i)) continue;
      const group = [pts[i]]; used.add(i);
      for (let j = i + 1; j < pts.length; j++) {
        if (used.has(j)) continue;
        const dx = pts[i].p.x - pts[j].p.x, dy = pts[i].p.y - pts[j].p.y;
        if (dx * dx + dy * dy < CLUSTER_PX * CLUSTER_PX) { group.push(pts[j]); used.add(j); }
      }
      if (group.length <= 1) continue;
      const ids = group.map((g) => g.n.id);
      ids.forEach((id) => clusteredIds.add(id));
      const lng = group.reduce((a, g) => a + g.c.lng, 0) / group.length;
      const lat = group.reduce((a, g) => a + g.c.lat, 0) / group.length;
      let worst = 'unknown', total = 0;
      for (const g of group) {
        const b = badgeFor(g.n, nodes, live);
        const s = b ? b.worst : effStatus(g.n, live[g.n.id]);
        if ((STATUS_RANK[s] ?? 0) >= (STATUS_RANK[worst] ?? 0)) worst = s;
        total += b ? Math.max(1, b.count) : 1; // un contenedor cuenta por sus miembros
      }
      bubbles.push({ key: Math.min(...ids), lng, lat, count: total, worst });
    }

    // ocultar markers de nodo que quedaron dentro de una burbuja
    for (const [id, entry] of markersRef.current) entry.el.style.display = clusteredIds.has(id) ? 'none' : '';
    // ocultar la etiqueta de distancia si algún extremo está agrupado
    for (const [eid, lbl] of edgeLabelsRef.current) {
      const e = edges.find((x) => x.id === eid);
      lbl.el.style.display = e && (clusteredIds.has(e.source_id) || clusteredIds.has(e.target_id)) ? 'none' : '';
    }
    // reconciliar burbujas de cluster
    const cm = clusterMarkersRef.current;
    const seen = new Set<number>();
    for (const b of bubbles) {
      seen.add(b.key);
      let entry = cm.get(b.key);
      if (!entry) {
        const el = document.createElement('div');
        el.className = 'geo-cluster';
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const m = mapRef.current; if (!m) return;
          m.easeTo({ center: [Number(el.dataset.lng), Number(el.dataset.lat)], zoom: Math.min(18, m.getZoom() + 2) });
        });
        entry = { marker: new maplibregl.Marker({ element: el }).setLngLat([b.lng, b.lat]).addTo(map), el };
        cm.set(b.key, entry);
      } else {
        entry.marker.setLngLat([b.lng, b.lat]);
      }
      const col = HEALTH_HEX[b.worst] ?? HEALTH_HEX.unknown;
      entry.el.dataset.lng = String(b.lng); entry.el.dataset.lat = String(b.lat);
      entry.el.textContent = String(b.count);
      entry.el.style.borderColor = col;
      entry.el.style.color = col;
      entry.el.style.boxShadow = `0 0 0 4px ${col}22, 0 4px 14px rgba(0,0,0,.45)`;
    }
    for (const [key, entry] of cm) if (!seen.has(key)) { entry.marker.remove(); cm.delete(key); }
  }, []);

  // --- crear el mapa una vez ---
  useEffect(() => {
    if (!maptilerKey || !containerRef.current) return;
    const placed = nodes.filter((n) => n.lat != null && n.lng != null);
    const center: [number, number] = placed.length
      ? [placed.reduce((a, n) => a + n.lng!, 0) / placed.length, placed.reduce((a, n) => a + n.lat!, 0) / placed.length]
      : [-74.5, 4.6]; // Colombia por defecto
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildStyle(maptilerKey, mapStyle, theme),
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
      map.on('move', recluster); // reagrupar al hacer zoom / pan
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

    return () => { clearInterval(anim); ro.disconnect(); map.remove(); mapRef.current = null; loadedRef.current = false; markersRef.current.clear(); clusterMarkersRef.current.clear(); edgeLabelsRef.current.clear(); setReady(false); };
    // Recrear el mapa si cambia la key, el estilo o el tema (claro/oscuro)
  }, [maptilerKey, mapStyle, theme]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- reconciliar markers cuando cambian los nodos (posición/alta/baja) ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const markers = markersRef.current;
    const eff = computeEffCoords(nodes);
    // Miembros que colapsan dentro de su torre/rack (no llevan marcador propio).
    const membersByContainer = new Map<number, ApiNode[]>();
    for (const n of nodes) { const c = eff.get(n.id); if (c?.inherited && n.containerId != null) (membersByContainer.get(n.containerId) ?? membersByContainer.set(n.containerId, []).get(n.containerId)!).push(n); }
    const seen = new Set<number>();
    for (const n of nodes) {
      const c = eff.get(n.id);
      if (!c || c.inherited) continue; // los miembros apilados se dibujan dentro de la torre
      seen.add(n.id);
      // Un contenedor con miembros apilados se dibuja como torre vertical; el resto, marcador normal.
      const stackMembers = CONTAINER_TYPES.includes(n.type) ? (membersByContainer.get(n.id) ?? []) : [];
      const kind: 'tower' | 'node' = stackMembers.length ? 'tower' : 'node';
      let entry = markers.get(n.id);
      if (entry && entry.kind !== kind) { entry.marker.remove(); markers.delete(n.id); entry = undefined; }
      if (!entry) {
        const el = kind === 'tower' ? buildTowerEl() : buildMarkerEl();
        el.dataset.cid = String(n.id);
        const marker = new maplibregl.Marker({ element: el, draggable: n.type !== 'monitor', anchor: kind === 'tower' ? 'bottom' : 'center' }).setLngLat([c.lng, c.lat]).addTo(map);
        let draggedAt = 0;
        marker.on('dragstart', () => { draggedAt = Date.now(); el.style.cursor = 'grabbing'; });
        marker.on('dragend', () => {
          draggedAt = Date.now(); el.style.cursor = '';
          const ll = marker.getLngLat();
          void api.updateNode(n.id, { lat: ll.lat, lng: ll.lng }).then(() => cbRef.current.onChanged());
        });
        // Clic limpio (no fue arrastre): abre el equipo (o el miembro pulsado en una torre).
        el.addEventListener('click', (ev) => {
          ev.stopPropagation(); if (Date.now() - draggedAt < 250) return;
          const item = (ev.target as HTMLElement).closest('[data-mid]');
          const mid = item?.getAttribute('data-mid');
          cbRef.current.onSelectNode(mid ? Number(mid) : Number(el.dataset.cid));
        });
        entry = { marker, el, kind };
        markers.set(n.id, entry);
      } else if (!entry.marker.isDraggable() || !(entry.el.style.cursor === 'grabbing')) {
        entry.marker.setLngLat([c.lng, c.lat]);
      }
      if (kind === 'tower') paintTower(entry.el, n, membersByContainer.get(n.id) ?? [], dataRef.current.live);
      else paintMarker(entry.el, n, dataRef.current.live[n.id], badgeFor(n, dataRef.current.nodes, dataRef.current.live));
    }
    for (const [id, entry] of markers) if (!seen.has(id)) { entry.marker.remove(); markers.delete(id); }
    recluster(); // reagrupar tras altas/bajas/movimientos
  }, [nodes, ready, recluster]);

  // --- actualizar visual de markers + líneas cuando cambia el estado en vivo ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const membersByContainer = new Map<number, ApiNode[]>();
    const effM = computeEffCoords(nodes);
    for (const n of nodes) { const c = effM.get(n.id); if (c?.inherited && n.containerId != null) (membersByContainer.get(n.containerId) ?? membersByContainer.set(n.containerId, []).get(n.containerId)!).push(n); }
    for (const n of nodes) {
      const entry = markersRef.current.get(n.id);
      if (!entry) continue;
      if (entry.kind === 'tower') paintTower(entry.el, n, membersByContainer.get(n.id) ?? [], live);
      else paintMarker(entry.el, n, live[n.id], badgeFor(n, nodes, live));
    }
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const eff = computeEffCoords(nodes);
    const labels = edgeLabelsRef.current;
    const seenL = new Set<number>();
    const features = edges.flatMap((e) => {
      const s = byId.get(e.source_id), t = byId.get(e.target_id);
      const sc = eff.get(e.source_id), tc = eff.get(e.target_id);
      if (!s || !t || !sc || !tc) return [];
      const rank = { down: 3, warning: 2, unknown: 1, up: 0 } as Record<string, number>;
      const a = effStatus(s, live[s.id]), b = effStatus(t, live[t.id]);
      const health = rank[a] >= rank[b] ? a : b;

      // Etiqueta de distancia geodésica en el punto medio (la fibra se resalta).
      const distM = haversineM(sc.lat, sc.lng, tc.lat, tc.lng);
      const isFiber = e.medium === 'fiber';
      seenL.add(e.id);
      let lbl = labels.get(e.id);
      if (!lbl) {
        const el = document.createElement('div');
        el.className = 'geo-dist';
        el.addEventListener('click', (ev) => { ev.stopPropagation(); cbRef.current.onSelectEdge(e.id); });
        const marker = new maplibregl.Marker({ element: el }).setLngLat([(sc.lng + tc.lng) / 2, (sc.lat + tc.lat) / 2]).addTo(map);
        lbl = { marker, el };
        labels.set(e.id, lbl);
      } else {
        lbl.marker.setLngLat([(sc.lng + tc.lng) / 2, (sc.lat + tc.lat) / 2]);
      }
      lbl.el.textContent = fmtDist(distM);
      lbl.el.title = isFiber ? `Fibra · ${fmtDist(distM)} (distancia en el mapa)` : fmtDist(distM);
      lbl.el.classList.toggle('is-fiber', isFiber);

      return [{ type: 'Feature' as const, properties: { id: e.id, color: HEALTH_HEX[health] }, geometry: { type: 'LineString' as const, coordinates: [[sc.lng, sc.lat], [tc.lng, tc.lat]] } }];
    });
    for (const [id, lbl] of labels) if (!seenL.has(id)) { lbl.marker.remove(); labels.delete(id); }
    const src = map.getSource('edges') as maplibregl.GeoJSONSource | undefined;
    src?.setData({ type: 'FeatureCollection', features });
    recluster(); // recolorear/ocultar según agrupación
  }, [live, nodes, edges, ready, recluster]);

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
