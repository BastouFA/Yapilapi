'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Button, Icon, useModalFocus } from '@yapilapi/design-system';
import type { CallInfo } from '@yapilapi/api-client';
import { api, errorMessage } from '@/lib/api';
import { useRealtime, useSession } from '@/app/providers';

type Phase = 'idle' | 'incoming' | 'outgoing' | 'active';
interface CallsCtx {
  start: (conversationId: string, kind: 'audio' | 'video') => Promise<void>;
}
const Ctx = createContext<CallsCtx>({ start: async () => {} });
export const useCalls = () => useContext(Ctx);

/**
 * Peer-to-peer calls (mesh, up to 8 people). The API relays offers, answers and
 * ICE candidates over the realtime socket; audio and video never pass through it.
 * The caller sends an offer to each person when they answer.
 */
export function CallsProvider({ children }: { children: React.ReactNode }) {
  const { me, toast, t } = useSession();
  const [call, setCall] = useState<CallInfo | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [remotes, setRemotes] = useState<Record<string, MediaStream>>({});
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const local = useRef<MediaStream | null>(null);
  const peers = useRef(new Map<string, RTCPeerConnection>());
  // ICE candidates can arrive before the offer or answer they belong to; hold them until then.
  const pending = useRef(new Map<string, RTCIceCandidateInit[]>());
  const ice = useRef<RTCIceServer[]>([]);
  const localVideo = useRef<HTMLVideoElement>(null);
  const callRef = useRef<CallInfo | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  callRef.current = call;
  // Keep keyboard focus in the call UI while it's up. No Escape: that shouldn't hang up.
  useModalFocus(overlay, phase !== 'idle' && !!call);

  const cleanup = useCallback(() => {
    peers.current.forEach((p) => p.close());
    peers.current.clear();
    pending.current.clear();
    local.current?.getTracks().forEach((t) => t.stop());
    local.current = null;
    setRemotes({});
    setCall(null);
    setPhase('idle');
    setMuted(false);
    setCameraOff(false);
  }, []);

  async function getMedia(kind: 'audio' | 'video') {
    local.current = await navigator.mediaDevices.getUserMedia({ audio: true, video: kind === 'video' });
    if (localVideo.current) localVideo.current.srcObject = local.current;
  }

  const peerFor = useCallback(
    (callId: string, userId: string) => {
      let pc = peers.current.get(userId);
      if (pc) return pc;
      pc = new RTCPeerConnection({ iceServers: ice.current });
      local.current?.getTracks().forEach((t) => pc!.addTrack(t, local.current!));
      pc.onicecandidate = (e) => e.candidate && void api.calls.signal(callId, userId, 'candidate', e.candidate.toJSON()).catch(() => {});
      pc.ontrack = (e) => setRemotes((r) => ({ ...r, [userId]: e.streams[0]! }));
      pc.onconnectionstatechange = () => {
        if (pc!.connectionState === 'failed') toast(t('m.calls.dropped'));
      };
      peers.current.set(userId, pc);
      return pc;
    },
    [toast, t],
  );

  const start = useCallback(
    async (conversationId: string, kind: 'audio' | 'video') => {
      try {
        const r = await api.calls.start(conversationId, kind);
        ice.current = r.iceServers;
        setCall(r.call);
        setPhase('outgoing');
        await getMedia(kind);
      } catch (e) {
        toast(e instanceof DOMException ? t('calls.allowToCall') : errorMessage(e));
        cleanup();
      }
    },
    [cleanup, toast, t],
  );

  async function answer() {
    if (!call) return;
    try {
      // Camera and microphone first, so the caller's offer (sent as soon as we answer) finds them ready.
      await getMedia(call.kind);
      ice.current = (await api.calls.get(call.id)).iceServers;
      const r = await api.calls.answer(call.id);
      ice.current = r.iceServers;
      setPhase('active');
    } catch (e) {
      toast(e instanceof DOMException ? t('calls.allowToAnswer') : errorMessage(e));
      await api.calls.decline(call.id).catch(() => {});
      cleanup();
    }
  }

  async function hangUp() {
    if (call) await api.calls.end(call.id).catch(() => {});
    cleanup();
  }

  useRealtime(async (e) => {
    const cur = callRef.current;
    if (e.type === 'call.incoming') {
      if (cur) return void api.calls.decline(e.data.id).catch(() => {}); // busy
      setCall(e.data);
      setPhase('incoming');
      return;
    }
    if (!cur || e.data?.callId !== cur.id) return;
    if (e.type === 'call.answered' && e.data.userId !== me?.id && cur.callerId === me?.id) {
      setPhase('active');
      const pc = peerFor(cur.id, e.data.userId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await api.calls.signal(cur.id, e.data.userId, 'offer', offer);
    }
    if (e.type === 'call.signal') {
      const pc = peerFor(cur.id, e.data.from);
      const flush = async () => {
        for (const c of pending.current.get(e.data.from) ?? []) await pc.addIceCandidate(c).catch(() => {});
        pending.current.delete(e.data.from);
      };
      if (e.data.type === 'offer') {
        await pc.setRemoteDescription(e.data.data);
        await flush();
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        await api.calls.signal(cur.id, e.data.from, 'answer', ans);
      } else if (e.data.type === 'answer') {
        await pc.setRemoteDescription(e.data.data);
        await flush();
      } else if (e.data.type === 'candidate') {
        if (pc.remoteDescription) await pc.addIceCandidate(e.data.data).catch(() => {});
        else pending.current.set(e.data.from, [...(pending.current.get(e.data.from) ?? []), e.data.data]);
      }
    }
    if (e.type === 'call.declined' || e.type === 'call.left') {
      peers.current.get(e.data.userId)?.close();
      peers.current.delete(e.data.userId);
      setRemotes((r) => {
        const n = { ...r };
        delete n[e.data.userId];
        return n;
      });
      if (cur.participants.length === 2) {
        toast(e.type === 'call.declined' ? t('m.calls.declined') : t('m.calls.ended'));
        cleanup();
      }
    }
  });

  // Ringing times out on the server after 45 seconds; mirror it here.
  useEffect(() => {
    if (phase !== 'incoming' && phase !== 'outgoing') return;
    const id = setTimeout(() => {
      toast(phase === 'incoming' ? t('m.calls.missed') : t('m.calls.noAnswer'));
      void hangUp();
    }, 45_000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  return (
    <Ctx.Provider value={{ start }}>
      {children}
      {phase !== 'idle' && call ? (
        <div className="call" role="dialog" aria-modal aria-label={phase === 'incoming' ? t('calls.incoming') : t('m.calls.call')} ref={overlay} tabIndex={-1}>
          {phase === 'incoming' ? (
            <div className="call__ring">
              <Icon name={call.kind === 'video' ? 'eye' : 'bell'} size={40} />
              <p>{t(call.kind === 'video' ? 'm.calls.incoming.video' : 'm.calls.incoming.audio')}</p>
              <div className="row">
                <Button onClick={answer}>{t('m.calls.answer')}</Button>
                <Button variant="danger" onClick={async () => (await api.calls.decline(call.id).catch(() => {}), cleanup())}>
                  {t('m.common.decline')}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="call__grid">
                {Object.entries(remotes).map(([uid, stream]) => (
                  <RemoteVideo key={uid} stream={stream} audioOnly={call.kind === 'audio'} />
                ))}
                {!Object.keys(remotes).length ? <p className="call__status">{phase === 'outgoing' ? t('m.calls.calling') : t('m.calls.connecting')}</p> : null}
              </div>
              {call.kind === 'video' ? <video ref={localVideo} className="call__self" autoPlay muted playsInline aria-label={t('m.calls.yourCamera')} /> : null}
              <div className="call__controls">
                <Button
                  variant="secondary"
                  onClick={() => {
                    local.current?.getAudioTracks().forEach((t) => (t.enabled = muted));
                    setMuted(!muted);
                  }}
                >
                  {muted ? t('m.calls.unmute') : t('m.calls.mute')}
                </Button>
                {call.kind === 'video' ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      local.current?.getVideoTracks().forEach((t) => (t.enabled = cameraOff));
                      setCameraOff(!cameraOff);
                    }}
                  >
                    {cameraOff ? t('m.calls.cameraOn') : t('m.calls.cameraOff')}
                  </Button>
                ) : null}
                <Button variant="danger" onClick={hangUp}>
                  {t('m.calls.hangUp')}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </Ctx.Provider>
  );
}

function RemoteVideo({ stream, audioOnly }: { stream: MediaStream; audioOnly: boolean }) {
  const { t } = useSession();
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline className={audioOnly ? 'call__audio' : 'call__remote'} aria-label={t('calls.participant')} />;
}
