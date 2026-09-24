import React, { useEffect, useState } from 'react';
import { BASE } from '../api/client';

// Watches the runner. When it stops answering (crashed, restarting, or not started yet) the editor says
// so instead of silently failing every click, and it recovers by itself when the runner is back.
export const ConnectionBanner: React.FC = () => {
  const [misses, setMisses] = useState(0);

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(`${BASE}/health`, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
        if (!res.ok) throw new Error(String(res.status));
        if (!stopped) setMisses(0);
      } catch {
        if (!stopped) setMisses((m) => m + 1);
      }
    };
    void check();
    const timer = setInterval(check, 4000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  if (misses < 2) return null;
  return (
    <div className="connection-banner" role="alert">
      Lost connection to the MangoAI engine. Retrying… Your work is saved; changes will work again once it is back.
    </div>
  );
};
