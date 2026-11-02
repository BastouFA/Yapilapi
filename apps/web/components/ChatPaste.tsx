'use client';

import { useEffect, useRef, useState, type ClipboardEvent, type RefObject } from 'react';
import { Icon, type MenuAction } from '@yapilapi/design-system';
import { copyableMedia, isVideoFile, type Message } from '@yapilapi/shared';
import { patiently } from '@yapilapi/api-client';
import { api, errorMessage } from '@/lib/api';
import { useSession, type Session } from '@/app/providers';
import { clearCopiedMedia, copyMedia, isStandIn, useCopiedMedia } from '@/lib/chat-clipboard';
import { copyImage, copyText, mediaToSend, readClipboard } from '@/lib/clipboard';

/**
 * Copy and paste in a chat, the same in a normal chat and beside the video in Watch together.
 * Words and photos go through the device's clipboard, so they also reach other apps. A voice message
 * or video can't, so the app keeps which message it was and pasting sends that message on.
 */

/** The ways to copy a message, for its menu. Never a view-once one, which is meant to go. */
export function copyActions(m: Message & { pending?: boolean }, { t, toast }: Pick<Session, 't' | 'toast'>): MenuAction[] {
  if (m.unsent || m.viewOnce) return [];
  const actions: MenuAction[] = [];
  const words = (label: Parameters<typeof t>[0], text: string) =>
    actions.push({
      label: t(label),
      icon: 'copy',
      onSelect: () => void copyText(text).then((ok) => toast(t(ok ? 'chat.copied' : 'common.copyFailed'))),
    });
  if (m.body) words('chat.copyText', m.body);
  if (m.transcript?.text) words('chat.copyWords', m.transcript.text);
  const media = copyableMedia(m);
  if (media)
    actions.push({
      label: t(media.kind === 'video' ? 'chat.copyVideo' : 'chat.copyVoice'),
      icon: 'copy',
      onSelect: () => {
        copyMedia(m.id, media.kind, media.durationMs);
        toast(t(media.kind === 'video' ? 'chat.videoCopied' : 'chat.voiceCopied'));
      },
    });
  const photo = m.attachments?.find((a) => a.kind === 'image' && !a.removed && !a.sensitive);
  if (photo)
    actions.push({
      label: t('chat.copyPhoto'),
      icon: 'copy',
      onSelect: () =>
        void copyImage(new URL(photo.url, location.origin).toString()).then((ok) => {
          // Where the browser can't, the photo opens: holding it there copies or saves it.
          if (ok) toast(t('chat.copied'));
          else window.open(photo.url, '_blank', 'noopener');
        }),
    });
  return actions;
}

/**
 * Cmd+C and Cmd+V on a Mac, Ctrl+C and Ctrl+V on Windows (and Ctrl+Insert, Shift+Insert), in a chat.
 * Words you've selected and a box you're typing in are the browser's own. This adds the rest: with
 * nothing selected, copying takes the whole message under the mouse or the keyboard's focus, and
 * pasting goes to the message box from anywhere on the page.
 */
export function useCopyPasteKeys({ messages, composer }: { messages: Message[] | null; composer: RefObject<HTMLTextAreaElement | null> }) {
  const { t, toast } = useSession();
  const latest = useRef({ messages, t, toast });
  latest.current = { messages, t, toast };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.defaultPrevented) return;
      const key = e.key.toLowerCase();
      const command = e.metaKey || e.ctrlKey;
      const copying = (command && !e.shiftKey && key === 'c') || (e.ctrlKey && key === 'insert');
      const pasting = (command && key === 'v') || (e.shiftKey && key === 'insert');
      if (!copying && !pasting) return;
      if (document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')) return;
      // A sheet or dialog is in front: the chat behind it stays out of this.
      if (document.querySelector('[aria-modal="true"], dialog[open]')) return;
      if (pasting) {
        // The browser's own paste follows the key, into the box that now has focus.
        composer.current?.focus();
        return;
      }
      if (window.getSelection()?.toString()) return;
      const row = document.querySelector('.chat-msg:hover') ?? document.querySelector('.chat-msg:focus-within');
      const { messages, t, toast } = latest.current;
      const message = row && messages?.find((m) => m.id === row.getAttribute('data-message'));
      if (!message) return;
      const actions = copyActions(message, { t, toast });
      // What the message mainly is: its photo, video or voice, otherwise its words.
      const first = (['chat.copyPhoto', 'chat.copyVideo', 'chat.copyVoice', 'chat.copyText', 'chat.copyWords'] as const)
        .map((label) => actions.find((a) => a.label === t(label)))
        .find(Boolean);
      if (!first) return;
      e.preventDefault();
      first.onSelect();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [composer]);
}

/** What's waiting to be pasted into this chat, and the ways to paste it. */
export function useChatPaste({
  conversationId,
  sendFile,
  insertText,
  onForwarded,
  off = false,
}: {
  conversationId: string;
  sendFile: (file: File, label: string) => Promise<boolean>;
  insertText: (text: string) => void;
  onForwarded: (sent: Message[]) => void;
  /** Editing a message: it can't take a file. */
  off?: boolean;
}) {
  const { t, toast } = useSession();
  const copied = useCopiedMedia();
  const [pasting, setPasting] = useState(false);
  // Photos and videos pasted from anywhere, waiting for a look and a tap: a paste can be the wrong thing.
  const [pasted, setPasted] = useState<File[]>([]);
  useEffect(() => setPasted([]), [conversationId]);

  /** Sends the copied voice message or video into this chat, the message itself. */
  async function pasteCopied() {
    if (!copied || pasting) return;
    setPasting(true);
    try {
      const { messages: sent } = await patiently(() => api.messages.forward(copied.messageId, [conversationId], `paste-${copied.at}`));
      onForwarded(sent);
      clearCopiedMedia();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setPasting(false);
    }
  }

  async function sendPasted() {
    const files = pasted;
    setPasted([]);
    for (const [i, f] of files.entries()) {
      const sent = await sendFile(f, isVideoFile(f) ? t('chat.sendingVideo') : t('chat.sendingPhoto'));
      if (!sent) return setPasted(files.slice(i));
    }
  }

  /** The Paste button: phones only offer their own Paste in a message box for words, not for a copied photo. */
  async function pasteFromClipboard() {
    const got = await readClipboard();
    if (!got) {
      if (copied) void pasteCopied();
      else toast(t('chat.pasteRefused'));
      return;
    }
    const media = mediaToSend(got.files, got.text);
    if (media.length) setPasted(media);
    else if (isStandIn(got.text)) {
      if (copied) void pasteCopied();
      else toast(t('chat.nothingToPaste'));
    } else if (got.text) insertText(got.text);
    else if (copied) void pasteCopied();
    else toast(t('chat.nothingToPaste'));
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (off) return;
    const text = e.clipboardData.getData('text/plain');
    const media = mediaToSend([...e.clipboardData.files], text);
    if (isStandIn(text)) {
      // The voice message or video you copied: the message itself, never these words. Sent already, nothing's left.
      e.preventDefault();
      if (copied) void pasteCopied();
    } else if (media.length) {
      e.preventDefault();
      setPasted(media);
    } else if (copied && !text && !e.clipboardData.files.length) {
      // Nothing else on the clipboard: Paste means what you copied here.
      e.preventDefault();
      void pasteCopied();
    }
  }

  return { copied, pasting, pasted, off, pasteCopied, sendPasted, clearPasted: () => setPasted([]), pasteFromClipboard, onPaste };
}

/** "Send what you pasted" and "Paste voice message" or "Paste video", kept with the message box so they're on screen wherever you've scrolled to. */
export function PasteStrips({ paste, busy }: { paste: ReturnType<typeof useChatPaste>; busy: boolean }) {
  const { t } = useSession();
  const [thumb, setThumb] = useState<string | null>(null);
  const first = paste.pasted[0];
  useEffect(() => {
    if (!first || isVideoFile(first)) return setThumb(null);
    const url = URL.createObjectURL(first);
    setThumb(url);
    return () => URL.revokeObjectURL(url);
  }, [first]);
  const { copied } = paste;
  if (paste.off) return null;
  return (
    <>
      {paste.pasted.length ? (
        <div className="chat-paste">
          <button type="button" className="chat-paste__send" disabled={busy} onClick={() => void paste.sendPasted()}>
            {thumb ? <img className="chat-paste__thumb" src={thumb} alt="" /> : <Icon name="play" size={18} />}
            <span>{t('chat.sendPasted')}</span>
            {paste.pasted.length > 1 ? <span className="chat-paste__time">{paste.pasted.length}</span> : null}
          </button>
          <button type="button" className="yp-action" aria-label={t('common.cancel')} title={t('common.cancel')} onClick={paste.clearPasted}>
            <Icon name="x" size={18} />
          </button>
        </div>
      ) : null}
      {copied ? (
        <div className="chat-paste">
          <button type="button" className="chat-paste__send" disabled={paste.pasting} onClick={() => void paste.pasteCopied()}>
            <Icon name={copied.kind === 'video' ? 'play' : 'mic'} size={18} />
            <span>{t(copied.kind === 'video' ? 'chat.pasteVideo' : 'chat.pasteVoice')}</span>
            {copied.durationMs ? (
              <span className="chat-paste__time">{`${Math.floor(copied.durationMs / 60_000)}:${String(Math.round(copied.durationMs / 1000) % 60).padStart(2, '0')}`}</span>
            ) : null}
          </button>
          <button type="button" className="yp-action" aria-label={t('common.cancel')} title={t('common.cancel')} onClick={clearCopiedMedia}>
            <Icon name="x" size={18} />
          </button>
        </div>
      ) : null}
    </>
  );
}
