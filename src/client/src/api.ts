// src/client/src/api.ts
async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as T;
}
async function jpost<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as T;
}
async function jdel<T>(url: string): Promise<T> {
  const r = await fetch(url, { method: 'DELETE' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as T;
}

export interface MemoryRow {
  id: string;
  type: string;
  source_id: string;
  content_preview: string;
  properties: {
    title?: string;
    tags?: string[];
    created_at: string;
  };
  created_at: number;
}

export const api = {
  listMemories: (params: { type?: string; limit?: number } = {}) => {
    const u = new URL('/api/memories', window.location.origin);
    if (params.type) u.searchParams.set('type', params.type);
    if (params.limit) u.searchParams.set('limit', String(params.limit));
    return jget<MemoryRow[]>(u.pathname + u.search);
  },
  searchMemories: (q: string, type?: string, limit = 10) => {
    const u = new URL('/api/memories/search', window.location.origin);
    u.searchParams.set('q', q);
    if (type) u.searchParams.set('type', type);
    u.searchParams.set('limit', String(limit));
    return jget<Array<{ id: string; type: string; score: number; snippet: string; title?: string }>>(u.pathname + u.search);
  },
  getMemory: (id: string) => jget<unknown>(`/api/memories/${id}`),
  deleteMemory: (id: string) => jdel<{ deleted: string }>(`/api/memories/${id}`),
  listSources: (module_id?: string) =>
    jget<Array<{ id: string; module_id: string; external_id: string; display_name: string; last_synced_at: number | null; enabled: boolean }>>(
      `/api/sources${module_id ? `?module_id=${encodeURIComponent(module_id)}` : ''}`,
    ),
  removeSource: (id: string) => jdel<{ removed: string }>(`/api/sources/${id}`),
  listTypes: () =>
    jget<Array<{ id: string; display_name: string; is_custom: boolean }>>(`/api/types`),
  listViews: () =>
    jget<Array<{ id: string; name: string; description: string | null; definition: object; pinned: boolean }>>(`/api/views`),
  createView: (body: { name: string; description?: string; definition: object; pinned?: boolean }) =>
    jpost<{ id: string }>(`/api/views`, body),
  deleteView: (id: string) => jdel<{ deleted: string }>(`/api/views/${id}`),
  dailyBuckets: (days = 30) => jget<Array<{ day: string; type: string; count: number }>>(`/api/daily/buckets?days=${days}`),
  dailyItems: (day: string, type?: string) =>
    jget<Array<MemoryRow>>(`/api/daily/items/${day}${type ? `?type=${encodeURIComponent(type)}` : ''}`),
  getSettings: () => jget<Record<string, unknown>>(`/api/settings`),
  setSetting: (key: string, value: unknown) =>
    fetch(`/api/settings/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    }).then((r) => r.json()),
  reindex: () =>
    fetch('/api/reindex', { method: 'POST' }).then((r) => r.json()),
  graph: (params?: { type?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.type) qs.set('type', params.type);
    if (params?.limit) qs.set('limit', String(params.limit));
    return fetch(`/api/graph?${qs}`).then((r) => r.json());
  },
  callMcpTool: async (name: string, args: Record<string, unknown>) => {
    // Use HTTP MCP transport directly — request a single tool call.
    const r = await fetch('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Math.random(),
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const json = await r.json();
    if (json.result?.content?.[0]?.text) {
      return JSON.parse(json.result.content[0].text);
    }
    return json;
  },
};
