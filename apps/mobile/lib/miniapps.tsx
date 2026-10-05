import { useEffect, useRef, useState } from 'react';
import { Alert, Linking, Modal, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import { client, errorMessage } from './api';
import { useFlag } from './flags';
import { useT } from './i18n';
import { space } from './theme';
import { BottomSheet, Button, ErrorState, Loading, Notice, useColors } from './ui';

export type MiniAppSurface = 'conversation' | 'community' | 'event' | 'profile';
type Installed = { id: string; name: string; description: string; entryUrl: string; permissions: string[] };
type Listed = { id: string; name: string; description: string; permissions: string[] };

/** What each permission lets an app see or do, in words. */
const PERMISSIONS: Record<string, MessageKey> = {
  profile: 'miniApps.perm.profile',
  members: 'miniApps.perm.members',
  post_message: 'miniApps.perm.postMessage',
};

/** Whether Mini Apps are on (the feature flag), for showing an "Apps" entry. */
export const useMiniAppsOn = () => useFlag('MINI_APPS') === true;

/**
 * Mini Apps in a chat, community, event or profile, as on the web: the apps added here (open,
 * remove) and the ones that can be added. Adding one first says what it will be able to see and
 * do. `canManage`: this person can add and remove apps here (anyone in a chat; a community's
 * admins; an event's host; a profile's owner); the server checks it too. An app opens full screen
 * once this sheet has closed (iOS can't show one sheet while another is closing).
 */
export function MiniAppsSheet({
  visible,
  onClose,
  surface,
  surfaceId,
  canManage = true,
  onSend,
}: {
  visible: boolean;
  onClose: () => void;
  surface: MiniAppSurface;
  surfaceId: string;
  canManage?: boolean;
  onSend?: (text: string) => Promise<void>;
}) {
  const c = useColors();
  const { t } = useT();
  const [installed, setInstalled] = useState<Installed[] | null>(null);
  const [directory, setDirectory] = useState<Listed[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<Listed | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [toOpen, setToOpen] = useState<Installed | null>(null);
  const [running, setRunning] = useState<Installed | null>(null);

  const load = () => {
    setError(null);
    void client()
      .then((api) => Promise.all([api.miniApps.installed(surface, surfaceId), canManage ? api.miniApps.directory(surface) : Promise.resolve({ items: [] })]))
      .then(
        ([i, d]) => {
          setInstalled(i.items);
          setDirectory(d.items);
        },
        (e) => setError(errorMessage(e)),
      );
  };
  useEffect(() => {
    if (!visible) return;
    setAdding(null);
    setNote(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, surface, surfaceId]);

  const notInstalled = directory.filter((d) => !installed?.some((i) => i.id === d.id));
  const permissionList = (perms: string[]) => perms.map((p) => (PERMISSIONS[p] ? t(PERMISSIONS[p]) : p));

  return (
    <>
      <BottomSheet
        visible={visible}
        title={adding ? t('miniApps.addTitle', { name: adding.name }) : t('chat.apps')}
        onClose={onClose}
        onDismiss={() => {
          if (toOpen) setRunning(toOpen);
          setToOpen(null);
        }}
      >
        {note ? <Notice>{note}</Notice> : null}
        {adding ? (
          // Before adding: what the app will be able to see and do here.
          <View style={{ gap: space[3] }}>
            <Text style={{ color: c.ink, lineHeight: 21 }}>{t('miniApps.otherDeveloper', { name: adding.name })}</Text>
            {adding.permissions.length ? (
              <View style={{ gap: space[1] }}>
                <Text style={{ color: c.ink, lineHeight: 21 }}>{t('miniApps.willSee')}</Text>
                {permissionList(adding.permissions).map((p) => (
                  <Text key={p} style={{ color: c.ink, lineHeight: 21 }}>
                    {`• ${p}`}
                  </Text>
                ))}
              </View>
            ) : (
              <Text style={{ color: c.ink, lineHeight: 21 }}>{t('miniApps.seesNothing')}</Text>
            )}
            <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>
              {t(surface === 'conversation' ? 'miniApps.everyoneHere.chat' : 'miniApps.everyoneHere.other')}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
              <Button
                label={t('settings.add')}
                disabled={busy}
                onPress={async () => {
                  setBusy(true);
                  try {
                    await (await client()).miniApps.install(adding.id, surface, surfaceId);
                    setNote(t('miniApps.addedToast', { name: adding.name }));
                    setAdding(null);
                    load();
                  } catch (e) {
                    setNote(errorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              />
              <Button label={t('common.cancel')} variant="secondary" onPress={() => setAdding(null)} />
            </View>
          </View>
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : installed === null ? (
          <Loading />
        ) : (
          <View style={{ gap: space[4] }}>
            <View style={{ gap: space[2] }}>
              <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>
                {t('miniApps.added')}
              </Text>
              {installed.length ? (
                installed.map((a) => (
                  <AppRow key={a.id} name={a.name} description={a.description}>
                    <Button
                      label={t('miniApps.open')}
                      accessibilityLabel={t('miniApps.openNamed', { name: a.name })}
                      size="sm"
                      onPress={() => {
                        setToOpen(a);
                        onClose();
                      }}
                    />
                    {canManage ? (
                      <Button
                        label={t('m.common.remove')}
                        accessibilityLabel={t('miniApps.removeNamed', { name: a.name })}
                        size="sm"
                        variant="ghost"
                        onPress={async () => {
                          try {
                            await (await client()).miniApps.uninstall(a.id, surface, surfaceId);
                            setNote(t('miniApps.removed', { name: a.name }));
                            load();
                          } catch (e) {
                            setNote(errorMessage(e));
                          }
                        }}
                      />
                    ) : null}
                  </AppRow>
                ))
              ) : (
                <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('miniApps.none')}</Text>
              )}
            </View>
            {canManage && notInstalled.length ? (
              <View style={{ gap: space[2] }}>
                <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>
                  {t('miniApps.addApp')}
                </Text>
                {notInstalled.map((a) => (
                  <AppRow key={a.id} name={a.name} description={a.description}>
                    <Button
                      label={t('settings.add')}
                      accessibilityLabel={t('miniApps.addNamed', { name: a.name })}
                      size="sm"
                      variant="secondary"
                      onPress={() => {
                        setNote(null);
                        setAdding(a);
                      }}
                    />
                  </AppRow>
                ))}
              </View>
            ) : null}
          </View>
        )}
      </BottomSheet>
      {running ? <MiniAppScreen app={running} surface={surface} surfaceId={surfaceId} onClose={() => setRunning(null)} onSend={onSend} /> : null}
    </>
  );
}

function AppRow({ name, description, children }: { name: string; description: string; children: React.ReactNode }) {
  const c = useColors();
  return (
    <View style={{ gap: space[2], paddingVertical: space[1] }}>
      <View style={{ gap: 2 }}>
        <Text style={{ color: c.ink, fontWeight: '600', fontSize: 15 }}>{name}</Text>
        {description ? <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{description}</Text> : null}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>{children}</View>
    </View>
  );
}

/**
 * The phone runs a Mini App as the page itself (on the web it's an iframe), so `window.parent` is
 * the app's own window. This keeps the web's messages working unchanged: what the app posts to its
 * host ({ type: 'ypl:ready' } or { type: 'ypl:send', text }) is handed to YAPILAPI, and YAPILAPI's
 * answer ({ type: 'ypl:context', token }) arrives as a window message, as in a browser.
 */
const BRIDGE = `(function () {
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== window || !d || typeof d !== 'object') return;
    if (d.type === 'ypl:ready' || d.type === 'ypl:send') {
      try { window.ReactNativeWebView.postMessage(JSON.stringify(d)); } catch (err) {}
    }
  });
})();
true;`;

/** The origin of an address, or null when it isn't one. */
function originOf(url: string): string | null {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(url);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * A Mini App, full screen. Like the web's sandboxed iframe: it keeps no cookies or storage
 * (incognito), gets no camera, microphone or files, stays on its own site (other links open in
 * the browser), and gets only a context token for this place, when it asks. Sending a message as
 * you is asked first, every time.
 */
function MiniAppScreen({
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
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const view = useRef<WebView>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const origin = originOf(app.entryUrl);

  const onMessage = async (e: WebViewMessageEvent) => {
    // Only messages from the app's own site count.
    if (!origin || originOf(e.nativeEvent.url) !== origin) return;
    let msg: { type?: string; text?: unknown };
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (msg.type === 'ypl:ready') {
      try {
        const { token } = await (await client()).miniApps.context(app.id, surface, surfaceId);
        view.current?.injectJavaScript(`window.postMessage(${JSON.stringify({ type: 'ypl:context', token })}, '*'); true;`);
        setProblem(null);
      } catch (err) {
        setProblem(errorMessage(err));
      }
    }
    if (msg.type === 'ypl:send' && typeof msg.text === 'string' && app.permissions.includes('post_message') && onSend) {
      const text = msg.text.slice(0, 2000);
      Alert.alert(t('miniApps.wantsToSend', { name: app.name }), text, [
        { text: t('miniApps.dontSend'), style: 'cancel' },
        {
          text: t('miniApps.sendAsMe'),
          onPress: () => {
            onSend(text).catch((err: unknown) => setProblem(errorMessage(err)));
          },
        },
      ]);
    }
  };

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: c.ground, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[3], paddingVertical: space[2] }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text accessibilityRole="header" numberOfLines={1} style={{ color: c.ink, fontWeight: '700', fontSize: 16 }}>
              {app.name}
            </Text>
            <Text numberOfLines={2} style={{ color: c.inkMuted, fontSize: 12, lineHeight: 16 }}>
              {t('miniApps.otherDeveloper', { name: app.name })}
            </Text>
          </View>
          <Button label={t('m.common.close')} variant="secondary" size="sm" onPress={onClose} />
        </View>
        {problem ? (
          <View style={{ paddingHorizontal: space[3], paddingBottom: space[2] }}>
            <Notice tone="danger">{problem}</Notice>
          </View>
        ) : null}
        {origin ? (
          <WebView
            ref={view}
            source={{ uri: app.entryUrl }}
            style={{ flex: 1, backgroundColor: '#FFFFFF' }}
            injectedJavaScriptBeforeContentLoaded={BRIDGE}
            onMessage={(e) => void onMessage(e)}
            originWhitelist={['https://*', 'http://*']}
            onShouldStartLoadWithRequest={(req) => {
              if (req.url === 'about:blank' || originOf(req.url) === origin) return true;
              // Anything else opens in the browser, outside YAPILAPI.
              if (/^https?:\/\//i.test(req.url)) void Linking.openURL(req.url).catch(() => {});
              return false;
            }}
            incognito
            sharedCookiesEnabled={false}
            thirdPartyCookiesEnabled={false}
            allowFileAccess={false}
            allowsBackForwardNavigationGestures={false}
            setSupportMultipleWindows={false}
            mediaCapturePermissionGrantType="deny"
            geolocationEnabled={false}
            startInLoadingState
            renderLoading={() => (
              <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', backgroundColor: c.ground }]}>
                <Loading />
              </View>
            )}
          />
        ) : (
          <View style={{ padding: space[3] }}>
            <Notice tone="danger">{t('error.generic')}</Notice>
          </View>
        )}
      </View>
    </Modal>
  );
}
