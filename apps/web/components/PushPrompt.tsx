'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BottomSheet, Button } from '@yapilapi/design-system';
import { currentSubscription, enableBrowserPush, pushConfig, pushSupported } from '@/lib/push';
import { useSession } from '@/app/providers';

const DISMISSED = 'yp.pushPrompt.dismissed';

function dismissed() {
  try {
    return localStorage.getItem(DISMISSED) === '1';
  } catch {
    return false;
  }
}

/**
 * At the top of the chat list: "Know when someone messages you", with Turn on notifications,
 * while this browser could get them and doesn't yet. Safari on an iPhone only gets them from the
 * Home Screen app, so there it says how (Yap says so already in its own bar).
 */
export function PushPrompt() {
  const { t, toast } = useSession();
  const path = usePathname();
  const [show, setShow] = useState<'ask' | 'install' | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    if (dismissed()) return;
    let live = true;
    const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone;
    const apple = /iPhone|iPad|iPod/.test(navigator.userAgent);
    if (!pushSupported()) {
      if (apple && !standalone && !path.startsWith('/yap')) setShow('install');
      return;
    }
    void Promise.all([pushConfig(), currentSubscription()]).then(([cfg, sub]) => {
      if (live && cfg.webPush && !sub) setShow('ask');
    });
    return () => {
      live = false;
    };
  }, [path]);

  if (!show) return null;
  const close = () => {
    try {
      localStorage.setItem(DISMISSED, '1');
    } catch {
      // Shown again next time.
    }
    setShow(null);
  };
  return (
    <section className="push-prompt" aria-labelledby="push-prompt-title">
      <h2 id="push-prompt-title" className="push-prompt__title">
        {t('push.prompt.title')}
      </h2>
      <p className="muted">{show === 'install' ? t('push.prompt.iosHint') : t('push.prompt.body')}</p>
      <div className="row">
        {show === 'ask' ? (
          <Button
            size="sm"
            icon="bell"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              const r = await enableBrowserPush().catch(() => 'unavailable' as const);
              setBusy(false);
              if (r === 'enabled') {
                toast(t('push.prompt.done'));
                setShow(null);
              } else if (r === 'denied') setBlocked(true);
              else toast(t('settings.push.unsupported'));
            }}
          >
            {t('push.prompt.turnOn')}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={close}>
          {t('push.prompt.notNow')}
        </Button>
      </div>
      <PushBlockedSheet open={blocked} onClose={() => setBlocked(false)} />
    </section>
  );
}

/**
 * The phone itself is blocking notifications: the browser answers "no" without asking anyone, so
 * nothing in the app can turn them on. What to do on this kind of device.
 */
export function PushBlockedSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useSession();
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const steps = /iPhone|iPad|iPod/.test(agent) ? 'push.blocked.ios' : /Android/.test(agent) ? 'push.blocked.android' : 'push.blocked.computer';
  return (
    <BottomSheet open={open} onClose={onClose} title={t('push.blocked.title')}>
      <p style={{ margin: 0 }}>{t(steps)}</p>
    </BottomSheet>
  );
}
