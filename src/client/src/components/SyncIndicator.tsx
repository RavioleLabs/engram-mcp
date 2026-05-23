// src/client/src/components/SyncIndicator.tsx
import { useQuery } from '@tanstack/react-query';

interface SyncStatus {
  enabled: boolean;
  device_id: string | null;
  lamport_ts: number;
  pending_ops: number;
  applied_ops: number;
  open_tombstones: number;
}

export function SyncIndicator() {
  const { data } = useQuery<SyncStatus>({
    queryKey: ['sync-status'],
    queryFn: () => fetch('/api/sync/status').then((r) => r.json() as Promise<SyncStatus>),
    refetchInterval: 5_000,
  });

  if (!data?.enabled) return null;

  return (
    <div className="flex items-center gap-1 text-xs text-gray-500">
      <span
        className={`h-2 w-2 rounded-full ${
          data.pending_ops > 0 ? 'bg-yellow-400' : 'bg-green-400'
        }`}
        title={`${data.pending_ops} ops pending sync`}
      />
      <span>{data.pending_ops > 0 ? `${data.pending_ops} pending` : 'synced'}</span>
    </div>
  );
}
