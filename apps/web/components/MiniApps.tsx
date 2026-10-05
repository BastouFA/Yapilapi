'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert, BottomSheet, Button, Dialog, List, ListItem, Skeleton, useModalFocus } from '@yapilapi/design-system';
import type { MiniAppSurface } from '@yapilapi/api-client';
import type { MessageKey } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

type Installed = { id: string; name: string; description: string; entryUrl: string; permissions: string[] };
type Listed = { id: string; name: string; description: string; permissions: string[] };

/** What each permission lets an app see or do, in words. */
const PERMISSIONS: Record<string, MessageKey> = {
  profile: 'miniApps.perm.profile',
  members: 'miniApps.perm.members',
  post_message: 'miniApps.perm.postMessage',
};

/**
 * Mini Apps in a conversation, community, event or profile. Apps run in a sandboxed
 * iframe with no access to YAPILAPI cookies or this page. They talk to the host
 * with postMessage:
 *   app → host  { type: 'ypl:ready' }            host replies { type: 'ypl:context', token }
 *   app → host  { type: 'ypl:send', text }       host asks the user, then sends it as them
 *
 * Adding one first says what it will be able to see and do. `canManage`: this person can add and
 * remove apps here (anyone in a chat; a community's admins; an event's host; a profile's owner);
 * the server checks it too.
 */
export function MiniAppsSheet({
  open,
  onClose,
  surface,
  surfaceId,
  canManage = true,
  onSend,
}: {
  open: boolean;
  onClose: () => void;
  surface: MiniAppSurface;
  surfaceId: string;
  canManage?: boolean;
  onSend?: (text: string) => Promise<void>;
}) {
  const { toast, flags, t } = useSession();
  const [installed, setInstalled] = useState<Installed[] | null>(null);
  const [directory, setDirectory] = useState<Listed[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<Installed | null>(null);
  const [adding, setAdding] = useState<Listed | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setError(null);
    Promise.all([api.miniApps.installed(surface, surfaceId), canManage ? api.miniApps.directory(surface) : Promise.resolve({ items: [] })]).then(
      ([i, d]) => {
        setInstalled(i.items);
        setDirectory(d.items);
      },
      (e) => setError(errorMessage(e)),
    );
  };
  useEffect(() => {
    if (open && flags.MINI_APPS) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, flags.MINI_APPS, surface, surfaceId]);

  if (!flags.MINI_APPS) return null;
  const notInstalled = directory.filter((d) => !installed?.some((i) => i.id === d.id));
  const permissionList = (perms: string[]) => perms.map((p) => (PERMISSIONS[p] ? t(PERMISSIONS[p]) : p));

  return (
    <>
      <BottomSheet open={open && !running && !adding} onClose={onClose} title={t('chat.apps')}>
        <div className="stack">
          {error ? (
            <Alert tone="danger">
              <span role="alert">{error}</span>{' '}
              <Button size="sm" variant="secondary" onClick={load}>
                {t('m.common.retry')}
              </Button>
            </Alert>
          ) : installed === null ? (
            <Skeleton height={80} />
          ) : installed.length ? (
            <List label={t('miniApps.added')}>
              {installed.map((a) => (
                <ListItem
                  key={a.id}
                  primary={a.name}
                  secondary={a.description}
                  end={
                    <span className="row" style={{ gap: 4 }}>
                      <Button size="sm" aria-label={t('miniApps.openNamed', { name: a.name })} onClick={() => setRunning(a)}>
                        {t('miniApps.open')}
                      </Button>
                      {canManage ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t('miniApps.removeNamed', { name: a.name })}
                          onClick={async () => {
                            try {
                              await api.miniApps.uninstall(a.id, surface, surfaceId);
                              toast(t('miniApps.removed', { name: a.name }));
                              load();
                            } catch (err) {
                              toast(errorMessage(err));
                            }
                          }}
                        >
                          {t('m.common.remove')}
                        </Button>
                      ) : null}
                    </span>
                  }
                />
              ))}
            </List>
          ) : (
            <p className="muted">{t('miniApps.none')}</p>
          )}
          {canManage && installed && notInstalled.length ? (
            <List label={t('miniApps.addApp')}>
              {notInstalled.map((a) => (
                <ListItem
                  key={a.id}
                  primary={a.name}
                  secondary={a.description}
                  end={
                    <Button size="sm" aria-label={t('miniApps.addNamed', { name: a.name })} onClick={() => setAdding(a)}>
                      {t('settings.add')}
                    </Button>
                  }
                />
              ))}
            </List>
          ) : null}
        </div>
      </BottomSheet>
      {/* Before adding: what the app will be able to see and do here. */}
      <Dialog
        open={!!adding}
        onClose={() => setAdding(null)}
        title={t('miniApps.addTitle', { name: adding?.name ?? '' })}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdding(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              loading={busy}
              onClick={async () => {
                if (!adding) return;
                setBusy(true);
                try {
                  await api.miniApps.install(adding.id, surface, surfaceId);
                  toast(t('miniApps.addedToast', { name: adding.name }));
                  setAdding(null);
                  load();
                } catch (e) {
                  toast(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('settings.add')}
            </Button>
          </>
        }
      >
        <div className="stack-sm">
          <p style={{ margin: 0 }}>{t('miniApps.otherDeveloper', { name: adding?.name ?? '' })}</p>
          {adding?.permissions.length ? (
            <>
              <p style={{ margin: 0 }}>{t('miniApps.willSee')}</p>
              <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                {permissionList(adding.permissions).map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </>
          ) : (
            <p style={{ margin: 0 }}>{t('miniApps.seesNothing')}</p>
          )}
          <p className="muted" style={{ margin: 0 }}>
            {t(surface === 'conversation' ? 'miniApps.everyoneHere.chat' : 'miniApps.everyoneHere.other')}
          </p>
        </div>
      </Dialog>
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
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { t, toast } = useSession();
  useModalFocus(overlay, true, onClose);
  const origin = new URL(app.entryUrl).origin;

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      // Only accept messages from this app's own frame and origin.
      if (e.source !== frame.current?.contentWindow || e.origin !== origin) return;
      const msg = e.data as { type?: string; text?: string };
      if (msg?.type === 'ypl:ready') {
        try {
          const { token } = await api.miniApps.context(app.id, surface, surfaceId);
          frame.current?.contentWindow?.postMessage({ type: 'ypl:context', token }, origin);
          setProblem(null);
        } catch (err) {
          setProblem(errorMessage(err));
        }
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
      {problem ? <Alert tone="danger">{problem}</Alert> : null}
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
              loading={sending}
              onClick={async () => {
                setSending(true);
                try {
                  await onSend?.(pending!);
                  setPending(null);
                } catch (err) {
                  toast(errorMessage(err));
                } finally {
                  setSending(false);
                }
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
