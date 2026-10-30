import { useEffect, useState } from 'react';

/**
 * Current time for display only. Elapsed time is always computed from the
 * stored Clock In timestamp, so it stays correct after closing the app,
 * locking the phone, a restart, or switching devices.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    let id = window.setInterval(tick, intervalMs);
    const onVis = () => {
      window.clearInterval(id);
      if (document.visibilityState === 'visible') {
        tick();
        id = window.setInterval(tick, intervalMs);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [intervalMs]);
  return now;
}
