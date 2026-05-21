// src/client/src/pages/Types.tsx
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';

export default function Types() {
  const qc = useQueryClient();
  const types = useQuery({ queryKey: ['types'], queryFn: () => api.listTypes() });

  const [newTypeName, setNewTypeName] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.callMcpTool('create_custom_type', {
        type_name: newTypeName,
        display_name: newDisplayName,
      }),
    onSuccess: () => {
      setNewTypeName('');
      setNewDisplayName('');
      qc.invalidateQueries({ queryKey: ['types'] });
    },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Memory Types</h1>

      <section className="space-y-2">
        <h2 className="text-lg">Active types</h2>
        <div className="grid grid-cols-3 gap-3">
          {types.data?.map((t) => (
            <div key={t.id} className="p-3 border border-zinc-800 rounded">
              <div className="font-medium">{t.display_name}</div>
              <div className="text-xs text-zinc-500">{t.is_custom ? 'custom' : 'built-in'}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg">Create a custom type</h2>
        <div className="flex gap-2">
          <input
            className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded"
            placeholder="type_name (snake_case)"
            value={newTypeName}
            onChange={(e) => setNewTypeName(e.target.value)}
          />
          <input
            className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded"
            placeholder="Display Name"
            value={newDisplayName}
            onChange={(e) => setNewDisplayName(e.target.value)}
          />
          <button
            className="px-4 py-2 bg-blue-500 text-white rounded"
            disabled={!newTypeName || !newDisplayName}
            onClick={() => create.mutate()}
          >
            Create
          </button>
        </div>
      </section>
    </div>
  );
}
