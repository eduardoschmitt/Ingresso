import { useEffect, useState } from 'react';

type ApiState = 'checking' | 'online' | 'offline';

const LABEL: Record<ApiState, string> = {
  checking: 'verificando…',
  online: 'online',
  offline: 'offline',
};

// Minimal React island proving hydration works. It only reads public
// availability state; the API/database remains the authority for inventory.
export default function ApiStatus() {
  const [status, setStatus] = useState<ApiState>('checking');

  useEffect(() => {
    const baseUrl = import.meta.env.PUBLIC_API_URL ?? 'http://localhost:3001';
    let cancelled = false;

    fetch(`${baseUrl}/health`)
      .then((response) => {
        if (!cancelled) setStatus(response.ok ? 'online' : 'offline');
      })
      .catch(() => {
        if (!cancelled) setStatus('offline');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <p role="status" className="font-mono text-sm">
      API:{' '}
      <span className={status === 'online' ? 'text-green-400' : 'text-amber-300'}>
        {LABEL[status]}
      </span>
    </p>
  );
}
