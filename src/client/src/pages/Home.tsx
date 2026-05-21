// src/client/src/pages/Home.tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import { MemoryCard } from '../components/MemoryCard.js';

export default function Home() {
  const recent = useQuery({ queryKey: ['recent'], queryFn: () => api.listMemories({ limit: 10 }) });
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api.listSources() });
  const types = useQuery({ queryKey: ['types'], queryFn: () => api.listTypes() });

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">EngramMCP</h1>
      <div className="grid grid-cols-3 gap-4">
        <Stat label="Memory types" value={types.data?.length ?? '…'} />
        <Stat label="Sources watched" value={sources.data?.length ?? '…'} />
        <Stat label="Recent items (24h)" value={recent.data?.filter((m) => Date.now() - m.created_at < 86_400_000).length ?? '…'} />
      </div>
      <section>
        <h2 className="text-lg mb-3">Recent</h2>
        <div className="space-y-2">
          {recent.data?.map((m) => <MemoryCard key={m.id} memory={m} />)}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="p-4 border border-zinc-800 rounded-lg">
      <div className="text-3xl font-semibold">{value}</div>
      <div className="text-sm text-zinc-500">{label}</div>
    </div>
  );
}
