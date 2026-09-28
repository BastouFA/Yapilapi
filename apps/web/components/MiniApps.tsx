'use client';

import { useEffect, useRef, useState } from 'react';
import { BottomSheet, Button, Dialog, List, ListItem, useModalFocus } from '@yapilapi/design-system';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

type Installed = { id: string; name: string; description: string; entryUrl: string; permissions: string[] };

/**
 * Mini Apps in a conversation (or community/event). Apps run in a sandboxed
 * iframe with no access to YAPILAPI cookies or this page. They talk to the host
 * with postMessage:
 *   app → host  { type: 'ypl:ready' }            host replies { type: 'ypl:context', token }
 *   app → host  { type: 'ypl:send', text }       host asks the user, then sends it as them
 */
export function MiniAppsSheet({
  open,
  onClose,
  surface,
  surfaceId,
  onSend,
}: {
  open: boolean;
  onClose: () => void;
  surface: 'conversation' | 'community' | 'event';
  surfaceId: string;
  onSend?: (text: string) => Promise<void>;
}) {
  const { toast, flags, t } = useSession();
  const [installed, setInstalled] = useState<Installed[]>([]);
  const [directory, setDirectory] = useState<{ id: string; name: string; description: string }[]>([]);
  const [running, setRunning] = useState<Installed | null>(null);

  const load = () => {
    api.miniApps.installed(surface, surfaceId).then(
      (r) => setInstalled(r.items),
      () => {},
    );
    api.miniApps.directory(surface).then(
      (r) => setDirectory(r.items),
      () => {},
    );
  };
  useEffect(() => {
    if (open && flags.MINI_APPS) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, flags.MINI_APPS]);

  if (!flags.MINI_APPS) return null;
  const notInstalled = directory.filter((d) => !installed.some((i) => i.id === d.id));

  return (
    <>
      <BottomSheet open={open && !running} onClose={onClose} title={t('chat.apps')}>
        <div className="stack">
          {installed.length ? (
            <List label={t('miniApps.added')}>
              {installed.map((a) => (
                <ListItem key={a.id} onClick={() => setRunning(a)} primary={a.name} secondary={a.description} />
              ))}
            </List>
          ) : (
            <p className="muted">{t('miniApps.none')}</p>
          )}
          {notInstalled.length ? (
            <List label={t('miniApps.addApp')}>
              {notInstalled.map((a) => (
                <ListItem
                  key={a.id}
                  primary={a.name}
                  secondary={a.description}
                  end={
                    <Button
                      size="sm"
                      onClick={async () => {
                        try {
                          await api.miniApps.install(a.id, surface, surfaceId);
                          load();
                        } catch (e) {
                          toast(errorMessage(e));
                        }
                      }}
                    >
                      {t('settings.add')}
                    </Button>
                  }
                />
              ))}
            </List>
          ) : null}
        </div>
      </BottomSheet>
      {running ? <MiniAppFrame app={running} surface={surface} surfaceId={surfaceId} onClose={() => setRunning(null)} onSend={onSend} /> : null}
    </>
  );
}

function MiniAppFrame({
  app,
  surface,
  surfaceId,
  onClose,
  onSend,
}: {
  app: Installed;
  surface: string;
  surfaceId: string;
  onClose: () => void;
  onSend?: (text: string) => Promise<void>;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<string | null>(null);
  const { t } = useSession();
  useModalFocus(overlay, true, onClose);
  const origin = new URL(app.entryUrl).origin;

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      // Only accept messages from this app's own frame and origin.
      if (e.source !== frame.current?.contentWindow || e.origin !== origin) return;
      const msg = e.data as { type?: string; text?: string };
      if (msg?.type === 'ypl:ready') {
        const { token } = await api.miniApps.context(app.id, surface, surfaceId);
        frame.current?.contentWindow?.postMessage({ type: 'ypl:context', token }, origin);
      }
      if (msg?.type === 'ypl:send' && typeof msg.text === 'string' && app.permissions.includes('post_message') && onSend) setPending(msg.text.slice(0, 2000));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [app, origin, surface, surfaceId, onSend]);

  return (
    <div
      className="call"
      role="dialog"
      aria-modal
      aria-label={app.name}
      ref={overlay}
      tabIndex={-1}
      style={{ background: 'var(--ground)', color: 'var(--ink)' }}
    >
      <iframe
        ref={frame}
        src={app.entryUrl}
        title={app.name}
        sandbox="allow-scripts allow-forms allow-popups"
        referrerPolicy="no-referrer"
        allow=""
        style={{ width: '100%', height: '100%', border: '1px solid var(--line)', borderRadius: 8, background: '#fff' }}
      />
      <div className="call__controls">
        <span className="muted">{t('miniApps.otherDeveloper', { name: app.name })}</span>
        <Button variant="secondary" onClick={onClose}>
          {t('m.common.close')}
        </Button>
      </div>
      <Dialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={t('miniApps.wantsToSend', { name: app.name })}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)}>
              {t('miniApps.dontSend')}
            </Button>
            <Button
              onClick={async () => {
                await onSend?.(pending!);
                setPending(null);
              }}
            >
              {t('miniApps.sendAsMe')}
            </Button>
          </>
        }
      >
        <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{pending}</p>
      </Dialog>
    </div>
  );
}
