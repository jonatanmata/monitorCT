import type { ApiNode, ApiEdge, LiveNode, Alert, LossMatrixCell, HourlyRow, NodeType } from './types';

async function http<T>(url: string, options?: RequestInit): Promise<T> {
  // Solo declaramos JSON cuando hay cuerpo: si se envía Content-Type: application/json
  // con cuerpo vacío (p. ej. DELETE o POST sin body), Fastify responde 400.
  const headers: Record<string, string> = { ...(options?.headers as Record<string, string>) };
  if (options?.body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  topology: () =>
    http<{ nodes: ApiNode[]; edges: ApiEdge[]; live: Record<number, LiveNode>; aiAvailable: boolean }>('/api/topology'),

  createNode: (body: Partial<ApiNode> & { credentials?: Record<string, string> }) =>
    http<ApiNode>('/api/nodes', { method: 'POST', body: JSON.stringify(body) }),

  updateNode: (id: number, body: Partial<ApiNode> & { credentials?: Record<string, string> }) =>
    http<ApiNode>(`/api/nodes/${id}`, { method: 'PUT', body: JSON.stringify(body) }),

  deleteNode: (id: number) => http<{ ok: boolean }>(`/api/nodes/${id}`, { method: 'DELETE' }),

  testNode: (id: number) =>
    http<Record<string, { ok: boolean; detail: string }>>(`/api/nodes/${id}/test`, { method: 'POST' }),

  createEdge: (body: { sourceId: number; targetId: number; label?: string; capacityMbps?: number; sourceInterface?: string }) =>
    http<ApiEdge>('/api/edges', { method: 'POST', body: JSON.stringify(body) }),

  updateEdge: (id: number, body: { label?: string; capacityMbps?: number | null; sourceInterface?: string }) =>
    http<ApiEdge>(`/api/edges/${id}`, { method: 'PUT', body: JSON.stringify(body) }),

  deleteEdge: (id: number) => http<{ ok: boolean }>(`/api/edges/${id}`, { method: 'DELETE' }),

  splitEdge: (id: number, nodes: { type: NodeType; name?: string }[]) =>
    http<{ nodes: ApiNode[]; edges: ApiEdge[] }>(`/api/edges/${id}/split`, {
      method: 'POST',
      body: JSON.stringify({ nodes }),
    }),

  metrics: (params: { nodeId?: number; edgeId?: number; metric: string; hoursBack?: number }) => {
    const q = new URLSearchParams();
    if (params.nodeId !== undefined) q.set('nodeId', String(params.nodeId));
    if (params.edgeId !== undefined) q.set('edgeId', String(params.edgeId));
    q.set('metric', params.metric);
    if (params.hoursBack) q.set('hoursBack', String(params.hoursBack));
    return http<{ points: { value: number; extra: string | null; ts: number }[] }>(`/api/metrics?${q}`);
  },

  availableMetrics: (params: { nodeId?: number; edgeId?: number }) => {
    const q = new URLSearchParams();
    if (params.nodeId !== undefined) q.set('nodeId', String(params.nodeId));
    if (params.edgeId !== undefined) q.set('edgeId', String(params.edgeId));
    return http<{ metrics: string[] }>(`/api/metrics/available?${q}`);
  },

  lossMatrix: (hoursBack = 24) => http<{ matrix: LossMatrixCell[] }>(`/api/loss-matrix?hoursBack=${hoursBack}`),

  correlation: (edgeId: number | null, daysBack = 7) =>
    http<{ hourly: HourlyRow[] }>(`/api/correlation?daysBack=${daysBack}${edgeId ? `&edgeId=${edgeId}` : ''}`),

  alerts: () => http<{ alerts: Alert[] }>('/api/alerts'),
  resolveAlert: (id: number) => http<{ ok: boolean }>(`/api/alerts/${id}/resolve`, { method: 'POST' }),

  settings: () =>
    http<{
      thresholds: Record<string, number>;
      pcProbeTargets: string[];
      hasApiKey: boolean;
      apiKeySource: 'env' | 'ui' | null;
      telegram: { enabled: boolean; hasToken: boolean; chatId: string };
    }>('/api/settings'),
  saveSettings: (body: {
    thresholds?: Record<string, number>;
    pcProbeTargets?: string[];
    anthropicApiKey?: string;
    clearApiKey?: boolean;
  }) => http<{ ok: boolean; hasApiKey: boolean }>('/api/settings', { method: 'PUT', body: JSON.stringify(body) }),
  testApiKey: (key?: string) =>
    http<{ ok: boolean; detail: string }>('/api/settings/test-api-key', {
      method: 'POST',
      body: JSON.stringify(key ? { key } : {}),
    }),

  saveTelegram: (body: { enabled?: boolean; botToken?: string; chatId?: string; clear?: boolean }) =>
    http<{ ok: boolean; telegram: { enabled: boolean; hasToken: boolean; chatId: string } }>(
      '/api/settings/telegram',
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  testTelegram: (body: { botToken?: string; chatId?: string }) =>
    http<{ ok: boolean; detail: string }>('/api/settings/telegram/test', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};
