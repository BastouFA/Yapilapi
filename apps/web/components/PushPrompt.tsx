'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@yapilapi/design-system';
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

  useEffect(() => {
    if (dismissed()) return;
    let live = true;
    const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone;
    const apple = /iPhone|iPad|iPod/.test(navigator.userAgent);
    if (!pushSupported()) {
      if (apple && !standalone && !path.startsWith('/yap')) setShow('install');
      return;
    }
    if (Notification.permission === 'denied') return;
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
              } else toast(r === 'denied' ? t('settings.push.denied') : t('settings.push.unsupported'));
            }}
          >
            {t('push.prompt.turnOn')}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={close}>
          {t('push.prompt.notNow')}
        </Button>
      </div>
    </section>
  );
}
