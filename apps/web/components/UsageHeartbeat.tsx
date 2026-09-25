'use client';

import { useEffect, useState } from 'react';
import { Button, Dialog } from '@yapilapi/design-system';
import { api } from '@/lib/api';

const shownKey = () => `ypl_break_${new Date().toDateString()}`;

/**
 * Records active minutes (once a minute, only while the tab is visible) and,
 * for a supervised teen past their daily reminder, shows a break prompt once a day.
 */
export function UsageHeartbeat() {
  const [prompt, setPrompt] = useState<number | null>(null);
  useEffect(() => {
    const beat = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await api.family.heartbeat();
        let shown = false;
        try {
          shown = localStorage.getItem(shownKey()) === '1';
        } catch {}
        if (r.overLimit && !shown) {
          setPrompt(r.minutesToday);
          try {
            localStorage.setItem(shownKey(), '1');
          } catch {}
        }
      } catch {
        // Offline or signed out: nothing to record.
      }
    };
    void beat();
    const id = setInterval(beat, 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <Dialog open={prompt !== null} onClose={() => setPrompt(null)} title="Time for a break?" footer={<Button onClick={() => setPrompt(null)}>Close</Button>}>
      <p style={{ margin: 0 }}>
        You've spent {prompt} minutes on YAPILAPI today, which is past the daily reminder your family set. Everything will still be here later.
      </p>
    </Dialog>
  );
}
