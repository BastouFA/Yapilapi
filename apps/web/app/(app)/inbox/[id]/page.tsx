'use client';

import {
  formatList,
  noticeText,
  isVideoFile,
  MEDIA_ACCEPT,
  MESSAGE_EDIT_MINUTES,
  messagePreviewOf,
  storyReplyLabel,
  WATCH_MAX_MEMBERS,
  type PinnedMessage,
} from '@yapilapi/shared';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AIPanel, BottomSheet, Button, ChatBubble, EmptyState, Icon, Menu, Skeleton, Switch, TranslatableText, type MenuAction } from '@yapilapi/design-system';
import type { ChatGame, Conversation, Message, ScheduledMessage } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { ReportSheet } from '@/components/PostList';
import { useRealtime, useSession } from '../../../providers';
import { useCalls } from '@/components/Calls';
import { MiniAppsSheet } from '@/components/MiniApps';
import { MessageAttachments, ViewOnceMessage, VoiceRecorder } from '@/components/ChatAttachments';
import { ViewOnceCapture } from '@/components/ViewOnceCapture';
import { TurnOnYapsPrompt, YapButton } from '@/components/Yap';
import { StoryCardView } from '@/components/StoryStickers';
import { NowStatusLine } from '@/components/ProfilePlus';
import {
  applyReaction,
  ChatSearch,
  disappearingLabel,
  DisappearingSheet,
  MessageQuote,
  PinnedBar,
  previewText,
  ReactionPicker,
  ReactionRow,
  SystemLine,
} from '@/components/ChatExtras';
import { SmartReplyChips } from '@/components/AiHelpers';
import { ListSheet, ListView, PollSheet, PollView, ReminderNote, ReminderSheet } from '@/components/ChatPolls';
import { ChatLookSheet, chatThemeClass, chatThemeVars, ScheduledList, ScheduleSheet, useScheduled } from '@/components/ChatLater';
import { useChatWatch, WatchBanner } from '@/components/WatchTogether';
import { GameCard } from '@/components/ChatGames';
import { ChatMixCard, ShareMixHereSheet } from '@/components/Mixes';
import { LocationCard, LocationRequestLine, ShareLocationSheet, SharingBanner, useLocationSharing } from '@/components/ChatLocation';
import { MarketListingChat, MarketOfferChat } from '@/components/MarketChat';

// The game boards and the sheet to start a game load after the chat itself; both stay closed until asked for.
const GameSheet = dynamic(() => import('@/components/ChatGameSheets').then((m) => m.GameSheet), { ssr: false });
const StartGameSheet = dynamic(() => import('@/components/ChatGameSheets').then((m) => m.StartGameSheet), { ssr: false });

type Pending = Message & { pending?: boolean };

export default function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const { me, t, toast, locale, setUnread, unread, flags, sendRealtime } = useSession();
  const [conv, setConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Pending[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [body, setBody] = useState('');
  // Who is typing here (the name), cleared a few seconds after their last keystroke or when their message arrives.
  const [typing, setTyping] = useState<{ userId: string; name: string } | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // When this person last said they were typing, so the others hear it at most every few seconds.
  const typingSent = useRef(0);
  function saidTyping() {
    const now = Date.now();
    if (now - typingSent.current < 3000) return;
    typingSent.current = now;
    sendRealtime({ type: 'typing', conversationId: id });
  }
  const [ai, setAi] = useState<{ title: string; text: string; notice?: string; plan?: Record<string, unknown> } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [reportId, setReportId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const calls = useCalls();
  const [appsOpen, setAppsOpen] = useState(false);
  const [pins, setPins] = useState<PinnedMessage[]>([]);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // The chat's options menu opens search; closing search puts focus back on that button.
  const chatMenu = useRef<HTMLDivElement>(null);
  const closeSearch = () => {
    setSearchOpen(false);
    requestAnimationFrame(() => chatMenu.current?.querySelector<HTMLButtonElement>('button[aria-haspopup]')?.focus());
  };
  const [disappearingOpen, setDisappearingOpen] = useState(false);
  const [jump, setJump] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [pollOpen, setPollOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [remindFor, setRemindFor] = useState<{ message: Message; scope: 'me' | 'group' } | null>(null);
  // Send later: your messages waiting here, the sheet to pick a time (or edit one), and the chat's look.
  const scheduled = useScheduled(id);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [editingScheduled, setEditingScheduled] = useState<ScheduledMessage | null>(null);
  const [lookOpen, setLookOpen] = useState(false);
  // Watch together: the session running here (a banner and a Join link on its line), and starting one.
  const router = useRouter();
  const { session: watching } = useChatWatch(id);
  const [startingWatch, setStartingWatch] = useState(false);
  async function watchTogether() {
    if (watching) return router.push(`/watch/${watching.id}`);
    setStartingWatch(true);
    try {
      const r = await api.watch.start(id);
      router.push(`/watch/${r.session.id}`);
    } catch (e) {
      toast(errorMessage(e));
      setStartingWatch(false);
    }
  }
  // Games: the sheet to start one, and the board that's open (by its card's message id, so live updates show in it).
  const [gameStartOpen, setGameStartOpen] = useState(false);
  const [boardFor, setBoardFor] = useState<string | null>(null);
  // A game opened from the start sheet whose card isn't among the messages loaded yet (an older one).
  const [looseGame, setLooseGame] = useState<ChatGame | null>(null);
  // Mixes: the sheet to share one of yours here.
  const [mixShareOpen, setMixShareOpen] = useState(false);
  // Sharing where you are: the sheet, your live share here (the banner), and where this device is (for distances, never sent).
  const [locationOpen, setLocationOpen] = useState(false);
  const sharing = useLocationSharing(id, me?.id);
  async function stopSharing() {
    const ended = await sharing.stop();
    if (ended) patchMessage(ended.messageId, (x) => (x.location ? { ...x, location: ended } : x));
  }
  async function askLocation() {
    try {
      const { message } = await api.conversations.askLocation(id);
      addMessage(message);
      toast(t('location.request.sent'));
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  const loadPins = () =>
    api.conversations.pins(id).then(
      (r) => setPins(r.items),
      () => {},
    );
  const patchMessage = (messageId: string, fn: (m: Pending) => Pending) => setMessages((cur) => cur?.map((x) => (x.id === messageId ? fn(x) : x)) ?? cur);
  const addMessage = (m: Message) => setMessages((cur) => (cur?.some((x) => x.id === m.id) ? cur : [...(cur ?? []), m]));

  useEffect(() => {
    api.conversations.get(id).then(
      (r) => setConv(r.conversation),
      (e) => toast(errorMessage(e)),
    );
    api.conversations.messages(id).then(
      (r) => {
        setMessages(r.items);
        setCursor(r.nextCursor);
        void api.conversations.read(id);
        setUnread({ messages: Math.max(0, unread.messages - (conv?.unreadCount ?? 0)) });
      },
      (e) => toast(errorMessage(e)),
    );
    void loadPins();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Follow the newest message (not when earlier ones are loaded above).
  const lastId = messages?.at(-1)?.id;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [lastId]);

  // Go to a message once it's on the page, and mark it for a moment.
  useEffect(() => {
    if (!jump) return;
    const el = document.getElementById(`msg-${jump}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    const target = jump;
    setHighlight(target);
    setJump(null);
    setTimeout(() => setHighlight((h) => (h === target ? null : h)), 1800);
  }, [jump, messages]);

  /** Scroll to a message, loading earlier ones until it's there. */
  async function jumpTo(target: string) {
    if (messages?.some((m) => m.id === target)) return setJump(target);
    let c = cursor;
    const earlier: Message[] = [];
    try {
      for (let i = 0; i < 20 && c && !earlier.some((m) => m.id === target); i++) {
        const r = await api.conversations.messages(id, c);
        earlier.unshift(...r.items);
        c = r.nextCursor;
      }
    } catch (e) {
      toast(errorMessage(e));
    }
    if (earlier.length) {
      setMessages((cur) => [...earlier, ...(cur ?? [])]);
      setCursor(c);
    }
    if (earlier.some((m) => m.id === target)) setJump(target);
    else toast(t('m.chat.notFound'));
  }

  useRealtime((e) => {
    // A new live connection (the server says `ready` on each): fetch what came in while it was
    // down. Messages already here, including older ones scrolled back to, stay.
    if (e.type === 'ready')
      api.conversations.messages(id).then(
        (page) =>
          setMessages((cur) => {
            if (!cur) return cur;
            const fresh = new Map(page.items.map((m) => [m.id, m]));
            const ids = new Set(cur.map((m) => m.id));
            const clientIds = new Set(cur.map((m) => m.clientId).filter(Boolean));
            return [...cur.map((m) => fresh.get(m.id) ?? m), ...page.items.filter((m) => !ids.has(m.id) && !(m.clientId && clientIds.has(m.clientId)))];
          }),
        () => {},
      );
    if (e.type === 'message.created' && e.data.conversationId === id) {
      setMessages((cur) => {
        if (!cur) return cur;
        const m = e.data as Message;
        if (cur.some((x) => x.id === m.id)) return cur;
        const pendingIdx = m.clientId ? cur.findIndex((x) => x.clientId === m.clientId) : -1;
        if (pendingIdx >= 0) return cur.map((x, i) => (i === pendingIdx ? m : x));
        return [...cur, m];
      });
      if (e.data.sender.id !== me?.id) void api.conversations.read(id);
      setTyping((cur) => (cur?.userId === e.data.sender.id ? null : cur));
    }
    // Disappeared (or removed by moderation), or deleted just for you on another device.
    if ((e.type === 'message.deleted' || e.type === 'message.hidden') && e.data.conversationId === id) {
      setMessages((cur) => cur?.filter((x) => x.id !== e.data.id) ?? cur);
      if (pins.some((p) => p.message.id === e.data.id)) void loadPins();
    }
    if (e.type === 'message.edited' && e.data.conversationId === id) {
      patchMessage(e.data.id, (x) => ({ ...x, body: e.data.body, lang: e.data.lang ?? null, editedAt: e.data.editedAt }));
      setMessages(
        (cur) =>
          cur?.map((x) => (x.replyTo && x.replyTo.id === e.data.id ? { ...x, replyTo: { ...x.replyTo, body: String(e.data.body).slice(0, 200) } } : x)) ?? cur,
      );
    }
    if (e.type === 'message.unsent' && e.data.conversationId === id) {
      patchMessage(e.data.id, (x) => ({
        ...x,
        unsent: true,
        body: '',
        attachments: [],
        reactions: undefined,
        viewOnce: undefined,
        story: undefined,
        poll: undefined,
        list: undefined,
        game: undefined,
        location: undefined,
        market: undefined,
        offer: undefined,
        reminder: undefined,
      }));
      if (boardFor === e.data.id) setBoardFor(null);
      const own = sharing.mine;
      if (own && own.messageId === e.data.id) sharing.apply({ ...own, live: false, stoppedAt: new Date().toISOString(), point: null });
      setMessages(
        (cur) =>
          cur?.map((x) => (x.replyTo && x.replyTo.id === e.data.id ? { ...x, replyTo: { ...x.replyTo, unsent: true, body: '', attachmentKind: null } } : x)) ??
          cur,
      );
      if (editing?.id === e.data.id) setEditing(null);
      if (replyTo?.id === e.data.id) setReplyTo(null);
    }
    // Your own taps are already shown.
    if (e.type === 'message.reaction' && e.data.conversationId === id && e.data.userId !== me?.id)
      patchMessage(e.data.id, (x) => applyReaction(x, e.data.emoji, false, !!e.data.removed));
    if (e.type === 'conversation.pins' && e.data.conversationId === id) void loadPins();
    // Live poll results and list changes, each as you see them; your next reminder on a message.
    if (e.type === 'poll.updated' && e.data.conversationId === id) patchMessage(e.data.id, (x) => (x.unsent ? x : { ...x, poll: e.data.poll }));
    if (e.type === 'list.updated' && e.data.conversationId === id) patchMessage(e.data.id, (x) => (x.unsent ? x : { ...x, list: e.data.list }));
    // A move, a forfeit or the end of a game: the card and any open board follow.
    if (e.type === 'game.updated' && e.data.conversationId === id) {
      patchMessage(e.data.id, (x) =>
        // An older update arriving late never winds the board back.
        x.unsent || (x.game && x.game.moveNumber > e.data.game.moveNumber) ? x : { ...x, game: e.data.game },
      );
      setLooseGame((g) => (g && g.id === e.data.game.id && g.moveNumber <= e.data.game.moveNumber ? e.data.game : g));
    }
    // Where someone is: the card moves, or says they stopped; your own share's banner follows.
    if (e.type === 'location.updated' && e.data.conversationId === id) {
      patchMessage(e.data.id, (x) => (x.unsent ? x : { ...x, location: e.data.location }));
      sharing.apply(e.data.location);
    }
    // A Market card changed (reserved, sold, an answer to an offer, a rating): it shows as it is now.
    if (e.type === 'market.updated' && e.data.conversationId === id)
      patchMessage(e.data.messageId, (x) =>
        x.unsent ? x : { ...x, ...(e.data.market ? { market: e.data.market } : {}), ...(e.data.offer ? { offer: e.data.offer } : {}) },
      );
    // "Ada added 3 songs": more adds raise the line's count.
    if (e.type === 'message.system' && e.data.conversationId === id) patchMessage(e.data.id, (x) => ({ ...x, system: e.data.system }));
    // A mix shared here changed: its cards show it as it is now (or that it's gone).
    if (e.type === 'mix.updated' && (e.data.conversationIds as string[] | undefined)?.includes(id)) {
      const mixId = e.data.mixId as string;
      api.mixes.get(mixId).then(
        (r) => setMessages((cur) => cur?.map((x) => (x.mix?.id === mixId ? { ...x, mix: { available: true as const, ...r.mix } } : x)) ?? cur),
        () => setMessages((cur) => cur?.map((x) => (x.mix?.id === mixId ? { ...x, mix: { id: mixId, available: false as const } } : x)) ?? cur),
      );
    }
    if (e.type === 'message.reminder' && e.data.conversationId === id) patchMessage(e.data.id, (x) => ({ ...x, reminder: e.data.reminder ?? undefined }));
    if (e.type === 'conversation.updated' && e.data.id === id) setConv((c) => (c ? { ...c, disappearingSeconds: e.data.disappearingSeconds } : c));
    // Someone changed the wallpaper or bubble colour: everyone sees the same.
    if (e.type === 'conversation.theme' && e.data.id === id) setConv((c) => (c ? { ...c, theme: e.data.theme } : c));
    // Someone opened a view-once photo you sent, or its file was deleted.
    if (e.type === 'view_once.updated' && e.data.conversationId === id)
      setMessages((cur) => cur?.map((x) => (x.id === e.data.id ? { ...x, viewOnce: e.data.viewOnce } : x)) ?? cur);
    // A message held for a check was let through: load it (or clear the "waiting" label on your own).
    if (e.type === 'message.released' && e.data.conversationId === id)
      api.conversations.messages(id).then(
        (r) => setMessages(r.items),
        () => {},
      );
    if (e.type === 'typing' && e.data.conversationId === id && e.data.userId !== me?.id) {
      const who = conv?.members.find((m) => m.id === e.data.userId)?.displayName ?? t('m.calls.someone');
      setTyping({ userId: e.data.userId, name: who });
      clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => setTyping(null), 5000);
    }
  });

  const fileInput = useRef<HTMLInputElement>(null);
  const viewOnceInput = useRef<HTMLInputElement>(null);
  // View once straight from the camera or the microphone.
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureStart, setCaptureStart] = useState<'photo' | 'voice'>('photo');
  const setCaptureMode = (m: 'voice') => {
    setCaptureStart(m);
    setCaptureOpen(true);
  };
  const [uploading, setUploading] = useState<string | null>(null);
  const [yapSettings, setYapSettings] = useState(false);
  const [smartSettings, setSmartSettings] = useState(false);
  // Suggested replies follow the newest message that has arrived (not one of yours still sending).
  const lastArrived = messages?.filter((m) => !m.pending).at(-1)?.id ?? null;

  /** Upload a photo, video or voice recording, then send it as a message (a yap, or view once). */
  async function sendFile(file: File, label: string, o: { kind?: 'yap'; viewOnce?: boolean } = {}) {
    if (!me) return;
    if (file.size > 50 * 1024 * 1024) return toast(t('chat.fileTooBig'));
    setUploading(label);
    try {
      const { media } = await api.media.upload(file, undefined, { viewOnce: o.viewOnce });
      const clientId = crypto.randomUUID();
      const { message, notice, noticeCode } = await api.conversations.send(id, '', clientId, [{ mediaId: media.id }], o);
      setMessages((cur) => (cur?.some((x) => x.id === message.id) ? cur : [...(cur ?? []), message]));
      const note = noticeText({ code: noticeCode, message: notice }, t);
      if (note) toast(note);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setUploading(null);
    }
  }

  async function saveEdit(m: Message) {
    const text = body.trim();
    if (!text) return toast(t('m.chat.editEmpty'));
    if (text === m.body) return cancelCompose();
    try {
      const { message } = await api.messages.edit(m.id, text);
      if (message) patchMessage(m.id, () => message);
      cancelCompose();
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  function cancelCompose() {
    if (editing) setBody('');
    setEditing(null);
    setReplyTo(null);
  }

  async function send() {
    if (editing) return saveEdit(editing);
    const text = body.trim();
    if (!text || !me) return;
    const quoting = replyTo;
    const clientId = crypto.randomUUID();
    const optimistic: Pending = {
      id: clientId,
      conversationId: id,
      sender: { id: me.id, username: me.username, displayName: me.displayName, avatarUrl: me.avatarUrl, mode: me.mode },
      body: text,
      replyToId: quoting?.id ?? null,
      replyTo: quoting ? messagePreviewOf(quoting) : undefined,
      attachments: [],
      createdAt: new Date().toISOString(),
      clientId,
      pending: true,
    };
    setMessages((cur) => [...(cur ?? []), optimistic]);
    setBody('');
    setReplyTo(null);
    try {
      const { message, notice, noticeCode } = await api.conversations.send(id, text, clientId, [], quoting ? { replyToId: quoting.id } : {});
      setMessages((cur) => cur?.map((x) => (x.clientId === clientId ? message : x)) ?? cur);
      const note = noticeText({ code: noticeCode, message: notice }, t);
      if (note) toast(note);
    } catch (e) {
      setMessages((cur) => cur?.filter((x) => x.clientId !== clientId) ?? cur);
      setBody(text);
      setReplyTo(quoting);
      toast(errorMessage(e));
    }
  }

  async function assist(task: 'summarize_conversation' | 'plan_from_message') {
    setAiLoading(true);
    try {
      if (task === 'summarize_conversation') {
        const r = await api.ai.assist({ task, conversationId: id });
        setAi({ title: t('chat.ai.summary'), text: String(r.output ?? ''), notice: r.notice });
      } else {
        const last = [...(messages ?? [])].reverse().find((m) => m.body)?.body ?? '';
        const r = await api.ai.assist({ task, input: last });
        const plan = r.output as Record<string, unknown>;
        setAi({
          title: t('chat.ai.planDraft'),
          text:
            Object.entries(plan)
              .filter(([, v]) => v && (!Array.isArray(v) || v.length))
              .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
              .join('\n') || t('chat.ai.planEmpty'),
          notice: r.notice,
          plan,
        });
      }
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setAiLoading(false);
    }
  }

  const canManage = conv?.kind === 'direct' || conv?.myRole === 'admin';
  const pinnedIds = new Set(pins.map((p) => p.message.id));

  function startReply(m: Message) {
    setEditing(null);
    setReplyTo(m);
    composer.current?.focus();
  }

  function startEdit(m: Message) {
    setReplyTo(null);
    setEditing(m);
    setBody(m.body);
    composer.current?.focus();
  }

  async function react(m: Message, emoji: string, on: boolean) {
    setPickerFor(null);
    if (!me) return;
    patchMessage(m.id, (x) => applyReaction(x, emoji, true, !on));
    try {
      if (on) await api.messages.react(m.id, emoji);
      else await api.messages.unreact(m.id, emoji);
    } catch (e) {
      patchMessage(m.id, (x) => applyReaction(x, emoji, true, on));
      toast(errorMessage(e));
    }
  }

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  /** What you can do with one message, from its menu. */
  function actionsFor(m: Pending, mine: boolean): MenuAction[] {
    const editable =
      mine &&
      !m.kind &&
      !m.viewOnce &&
      !m.poll &&
      !m.list &&
      !m.game &&
      !m.mix &&
      !m.location &&
      !m.market &&
      !m.offer &&
      !m.unsent &&
      !m.pending &&
      Date.now() - new Date(m.createdAt).getTime() < MESSAGE_EDIT_MINUTES * 60_000;
    const pinned = pinnedIds.has(m.id);
    const actions: MenuAction[] = [];
    if (!m.unsent) {
      actions.push({ label: t('m.chat.reply'), icon: 'message', onSelect: () => startReply(m) });
      actions.push({ label: t('chat.react'), icon: 'heart', onSelect: () => setPickerFor(m.id) });
    }
    if (editable) actions.push({ label: t('m.chat.edit'), icon: 'create', onSelect: () => startEdit(m) });
    if (canManage && !m.unsent && !m.moderation)
      actions.push(
        pinned
          ? { label: t('m.chat.unpin'), icon: 'map-pin', onSelect: () => void run(async () => setPins((await api.messages.unpin(m.id)).items)) }
          : { label: t('m.chat.pin'), icon: 'map-pin', onSelect: () => void run(async () => setPins((await api.messages.pin(m.id)).items)) },
      );
    if (!m.unsent && !m.pending && !m.moderation) {
      const reminder = m.reminder;
      actions.push(
        reminder
          ? {
              label: t('m.chat.remind.cancel'),
              icon: 'bell',
              onSelect: () =>
                void run(async () => {
                  await api.messages.cancelReminder(reminder.id);
                  patchMessage(m.id, (x) => ({ ...x, reminder: undefined }));
                  toast(t('m.chat.remind.cancelled'));
                }),
            }
          : { label: t('m.chat.remind.me'), icon: 'bell', onSelect: () => setRemindFor({ message: m, scope: 'me' }) },
      );
      if (conv?.kind === 'group' && conv.myRole === 'admin')
        actions.push({ label: t('m.chat.remind.group'), icon: 'users', onSelect: () => setRemindFor({ message: m, scope: 'group' }) });
    }
    if (!mine && !m.unsent) actions.push({ label: t('post.report'), icon: 'flag', onSelect: () => setReportId(m.id) });
    actions.push({
      label: t('m.chat.deleteForMe'),
      icon: 'trash',
      onSelect: () =>
        void run(async () => {
          await api.messages.deleteForMe(m.id);
          setMessages((cur) => cur?.filter((x) => x.id !== m.id) ?? cur);
        }),
    });
    if (mine && !m.unsent)
      actions.push({
        label: t('m.chat.unsend'),
        icon: 'x-circle',
        danger: true,
        onSelect: () => {
          if (!confirm(t('m.chat.unsendConfirm'))) return;
          void run(async () => {
            const { message } = await api.messages.unsend(m.id);
            if (message) patchMessage(m.id, () => message);
          });
        },
      });
    return actions;
  }

  const others = conv?.members.filter((m) => m.id !== me?.id) ?? [];
  const canCall = !!conv && conv.kind !== 'community' && conv.members.length > 1 && conv.members.length <= 8;
  const title = conv ? conv.title || others.map((m) => m.displayName).join(', ') : '';
  // Watch together: one-to-one chats and groups of up to 8 people.
  const watchable = !!conv && (conv.kind === 'direct' || conv.kind === 'group') && conv.members.length <= WATCH_MAX_MEMBERS;
  let lastDay = '';

  return (
    <div className="yp-shell__inner chat-page">
      <div className="yp-topbar">
        <div className="row" style={{ minWidth: 0 }}>
          <Link href="/inbox" className="yp-action" aria-label={t('chat.backToInbox')}>
            <Icon name="arrow-left" />
          </Link>
          <div className="chat-title">
            <h1 style={{ fontSize: 20, lineHeight: '26px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {title || <Skeleton width={160} />}
            </h1>
            {conv?.nowStatus ? <NowStatusLine status={conv.nowStatus} compact /> : null}
          </div>
        </div>
        <div ref={chatMenu} className="row chat-head__actions">
          {watchable ? (
            <button
              type="button"
              className="yp-action"
              aria-label={watching ? `${t('watch.now')}: ${t('watch.join')}` : t('watch.start')}
              title={watching ? t('watch.now') : t('watch.start')}
              aria-busy={startingWatch || undefined}
              disabled={startingWatch}
              onClick={() => void watchTogether()}
            >
              <Icon name="play" />
            </button>
          ) : null}
          {/* Calls sit in the header, as on the phone: chats of 2 to 8 people, not communities. */}
          {canCall ? (
            <>
              <button
                type="button"
                className="yp-action"
                aria-label={t('chat.audioCall')}
                title={t('chat.audioCall')}
                onClick={() => void calls.start(id, 'audio')}
              >
                <Icon name="phone" />
              </button>
              <button
                type="button"
                className="yp-action"
                aria-label={t('chat.videoCall')}
                title={t('chat.videoCall')}
                onClick={() => void calls.start(id, 'video')}
              >
                <Icon name="video" />
              </button>
            </>
          ) : null}
          <Menu
            label={t('chat.options')}
            actions={[
              { label: t('chat.apps'), icon: 'create', onSelect: () => setAppsOpen(true) },
              { label: t('inbox.summarize'), icon: 'sparkle', onSelect: () => assist('summarize_conversation') },
              { label: t('chat.ai.draftPlan'), icon: 'calendar', onSelect: () => assist('plan_from_message') },
              { label: t('m.chat.search'), icon: 'search', onSelect: () => setSearchOpen(true) },
              { label: t('m.chat.disappearing'), icon: 'info', onSelect: () => setDisappearingOpen(true) },
              { label: t('m.chat.look.title'), icon: 'palette', onSelect: () => setLookOpen(true) },
              // A shared album for the people in this chat (a card goes in the chat).
              ...(flags.REAL_TOGETHER && (conv?.kind === 'direct' || conv?.kind === 'group')
                ? [{ label: t('together.chat.start'), icon: 'image' as const, onSelect: () => router.push(`/together/new?chat=${id}`) }]
                : []),
              ...(others.length === 1
                ? [
                    {
                      label: t('chat.viewProfile', { name: others[0]!.displayName }),
                      icon: 'user' as const,
                      onSelect: () => (location.href = `/u/${others[0]!.username}`),
                    },
                  ]
                : []),
              ...(conv?.yaps?.available ? [{ label: t('m.yap.settings'), icon: 'volume' as const, onSelect: () => setYapSettings(true) }] : []),
              ...(conv?.smartReplies ? [{ label: t('smartReplies.label'), icon: 'sparkle' as const, onSelect: () => setSmartSettings(true) }] : []),
            ]}
          />
        </div>
      </div>

      <WatchBanner session={watching} />
      <SharingBanner share={sharing.mine} here={sharing.here} onStop={stopSharing} />
      {conv?.disappearingSeconds ? (
        <button type="button" className="chat-disappearing" onClick={() => setDisappearingOpen(true)}>
          <Icon name="info" size={14} /> {t('m.chat.disappearingOn', { time: disappearingLabel(t, conv.disappearingSeconds) })}
        </button>
      ) : null}
      <PinnedBar
        pins={pins}
        canManage={canManage}
        onJump={(mid) => void jumpTo(mid)}
        onUnpin={(mid) => void run(async () => setPins((await api.messages.unpin(mid)).items))}
      />
      {/* Search opens over the chat, so the conversation underneath keeps its place. Picking a result closes it and goes there. */}
      <BottomSheet open={searchOpen} onClose={closeSearch} title={t('m.chat.search')}>
        {searchOpen ? (
          <ChatSearch
            conversationId={id}
            onJump={(mid) => {
              setSearchOpen(false);
              void jumpTo(mid);
            }}
            onClose={closeSearch}
          />
        ) : null}
      </BottomSheet>

      {ai || aiLoading ? (
        <AIPanel
          title={ai?.title ?? t('chat.ai.working')}
          loading={aiLoading}
          notice={ai?.notice}
          actions={
            ai ? (
              <>
                {ai.plan ? (
                  <Button
                    size="sm"
                    onClick={async () => {
                      await api.conversations.createPlan(id, String(ai.plan!.destination ?? t('chat.ai.newPlan')), ai.plan!);
                      toast(t('chat.ai.planSaved'));
                      setAi(null);
                    }}
                  >
                    {t('chat.ai.savePlan')}
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => setAi(null)}>
                  {t('m.common.close')}
                </Button>
              </>
            ) : null
          }
        >
          {ai?.text}
        </AIPanel>
      ) : null}

      {messages === null ? (
        <Skeleton height={300} />
      ) : (
        <div
          className={`yp-chat ${chatThemeClass(conv?.theme)}`}
          style={chatThemeVars(conv?.theme)}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label={t('chat.messages')}
        >
          {cursor ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                const r = await api.conversations.messages(id, cursor);
                setMessages((cur) => [...r.items, ...(cur ?? [])]);
                setCursor(r.nextCursor);
              }}
            >
              {t('chat.loadEarlier')}
            </Button>
          ) : null}
          {/* A new chat: who is in it, so the first message has somewhere to start. */}
          {!messages.length && conv ? (
            <EmptyState
              title={t('m.chat.empty.title')}
              body={t('m.chat.empty.body', {
                names: formatList(
                  others.map((o) => o.displayName),
                  locale,
                ),
              })}
            />
          ) : null}
          {messages.map((m) => {
            const day = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(m.createdAt));
            const showDay = day !== lastDay;
            lastDay = day;
            const mine = m.sender.id === me?.id;
            if (m.kind === 'system')
              return (
                <div key={m.id} id={`msg-${m.id}`} style={{ display: 'contents' }}>
                  {showDay ? <div className="yp-chat__day">{day}</div> : null}
                  {m.system?.type === 'location_request' ? (
                    <LocationRequestLine message={m} meId={me?.id} onShare={() => setLocationOpen(true)} />
                  ) : (
                    <SystemLine message={m} meId={me?.id} onJump={(mid) => void jumpTo(mid)} watchSessionId={watching?.id} />
                  )}
                </div>
              );
            const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(m.createdAt));
            // The text, with "See translation" when it's in a language the reader doesn't understand.
            // A reply to a story says so first ("Replied to your story"), in your language.
            const replied = m.storyReply ? <span className="chat-story-reply">{storyReplyLabel(m.storyReply, m.sender.id, me?.id, t)}</span> : null;
            const said = m.body ? <TranslatableText kind="message" id={m.id} text={m.body} lang={m.lang} own={mine || !!m.pending} locale={locale} /> : null;
            const text = replied ? (
              <>
                {replied}
                {said}
              </>
            ) : (
              said
            );
            const content = m.unsent ? (
              <span className="chat-unsent">{mine ? t('m.chat.unsentMine') : t('m.chat.unsent')}</span>
            ) : m.poll ? (
              <PollView message={m} meId={me?.id} mine={mine} onPoll={(poll) => patchMessage(m.id, (x) => ({ ...x, poll }))} />
            ) : m.list ? (
              <ListView message={m} meId={me?.id} mine={mine} onList={(list) => patchMessage(m.id, (x) => ({ ...x, list }))} />
            ) : m.game ? (
              <GameCard message={m} meId={me?.id} mine={mine} onOpen={() => setBoardFor(m.id)} />
            ) : m.mix ? (
              <ChatMixCard mix={m.mix} onMix={(mix) => patchMessage(m.id, (x) => ({ ...x, mix }))} />
            ) : m.location ? (
              <LocationCard message={m} meId={me?.id} mine={mine} viewer={sharing.viewer} onViewer={sharing.setViewer} onStop={stopSharing} />
            ) : m.market ? (
              <MarketListingChat card={m.market} onCard={(market) => patchMessage(m.id, (x) => ({ ...x, market }))} />
            ) : m.offer ? (
              <MarketOfferChat offer={m.offer} meId={me?.id} onOffer={(offer) => patchMessage(m.id, (x) => ({ ...x, offer }))} onMessage={addMessage} />
            ) : m.viewOnce ? (
              <>
                <ViewOnceMessage message={m} mine={mine} onChange={(next) => setMessages((cur) => cur?.map((x) => (x.id === next.id ? next : x)) ?? cur)} />
                {text}
              </>
            ) : m.attachments.length || m.story ? (
              <>
                {m.kind === 'yap' ? <span className="chat-yap-label">{t('m.yap.label')}</span> : null}
                {m.story ? <StoryCardView card={m.story} /> : null}
                {m.attachments.length ? <MessageAttachments items={m.attachments} /> : null}
                {text}
              </>
            ) : (
              text
            );
            return (
              <div key={m.id} style={{ display: 'contents' }}>
                {showDay ? <div className="yp-chat__day">{day}</div> : null}
                <div
                  id={`msg-${m.id}`}
                  className={`chat-msg${mine ? ' chat-msg--mine' : ''}${highlight === m.id ? ' chat-msg--highlight' : ''}`}
                  onContextMenu={(e) => {
                    if (mine || m.unsent) return;
                    e.preventDefault();
                    setReportId(m.id);
                  }}
                >
                  <div className="chat-msg__line">
                    <ChatBubble
                      locale={locale}
                      mine={mine}
                      sender={others.length > 1 ? m.sender.displayName : undefined}
                      body={
                        <>
                          {m.replyTo && !m.unsent ? <MessageQuote preview={m.replyTo} mine={mine} meId={me?.id} onJump={(mid) => void jumpTo(mid)} /> : null}
                          {content}
                        </>
                      }
                      pending={m.pending}
                      time={m.editedAt && !m.unsent ? t('chat.editedAt', { time }) : time}
                    />
                    {!m.pending ? (
                      <div className="chat-msg__tools">
                        {!m.unsent ? (
                          <>
                            <button
                              type="button"
                              className="yp-action chat-msg__quick"
                              aria-label={t('m.chat.reply')}
                              title={t('m.chat.reply')}
                              onClick={() => startReply(m)}
                            >
                              <Icon name="message" size={18} />
                            </button>
                            <button
                              type="button"
                              className="yp-action chat-msg__quick"
                              aria-label={t('chat.react')}
                              title={t('chat.react')}
                              onClick={() => setPickerFor(m.id)}
                            >
                              <Icon name="heart" size={18} />
                            </button>
                          </>
                        ) : null}
                        <Menu label={t('m.chat.messageOptions')} actions={actionsFor(m, mine)} />
                      </div>
                    ) : null}
                  </div>
                  {pickerFor === m.id ? (
                    <ReactionPicker
                      onPick={(emoji) => void react(m, emoji, !m.reactions?.some((r) => r.emoji === emoji && r.mine))}
                      onClose={() => setPickerFor(null)}
                    />
                  ) : null}
                  <ReactionRow message={m} mine={mine} onToggle={(emoji, on) => void react(m, emoji, on)} />
                  {m.moderation === 'review' ? <span className="chat-held">{t('m.chat.held')}</span> : null}
                  {m.reminder && !m.unsent ? <ReminderNote at={m.reminder.remindAt} /> : null}
                </div>
              </div>
            );
          })}
          {/* Only you see these until they're sent. */}
          <ScheduledList
            items={scheduled.items}
            onEdit={(s) => {
              setEditingScheduled(s);
              setScheduleOpen(true);
            }}
            // The focused button goes with the message: focus moves to the message box.
            onSent={(s, message) => {
              scheduled.setItems((cur) => cur.filter((x) => x.id !== s.id));
              addMessage(message);
              composer.current?.focus();
            }}
            onRemoved={(s) => {
              scheduled.setItems((cur) => cur.filter((x) => x.id !== s.id));
              composer.current?.focus();
            }}
          />
          {typing ? (
            <span className="muted" style={{ fontSize: 12 }}>
              {t('chat.typing', { name: typing.name })}
            </span>
          ) : null}
          <div ref={endRef} />
        </div>
      )}

      {conv?.yaps?.available ? (
        <div className="yap-row">
          <TurnOnYapsPrompt />
          <YapButton disabled={!!uploading} onError={toast} onRecorded={(f) => void sendFile(f, t('chat.sendingYap'), { kind: 'yap' })} />
        </div>
      ) : null}
      {!editing ? (
        <SmartReplyChips
          conversationId={id}
          lastMessageId={lastArrived}
          enabled={!!conv?.smartReplies?.on}
          onPick={(text) => {
            setBody(text);
            composer.current?.focus();
          }}
        />
      ) : null}
      <form
        className={`yp-composer${replyTo || editing ? ' yp-composer--context' : ''}`}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {replyTo || editing ? (
          <div className="chat-compose-context">
            {/* The message box is described by this, so "Replying to …" is read when it gets focus. */}
            <div style={{ minWidth: 0 }} id="compose-context">
              <span className="chat-compose-context__label">
                {editing
                  ? t('m.chat.editing')
                  : replyTo!.sender.id === me?.id
                    ? t('m.chat.replyingToSelf')
                    : t('m.chat.replyingTo', { name: replyTo!.sender.displayName })}
              </span>
              {replyTo ? (
                <span className="chat-compose-context__text" dir="auto">
                  {previewText(t, messagePreviewOf(replyTo), { meId: me?.id, locale })}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className="yp-action"
              aria-label={editing ? t('m.chat.cancelEdit') : t('m.chat.cancelReply')}
              onClick={() => {
                cancelCompose();
                // This button goes away; keep focus in the message box.
                composer.current?.focus();
              }}
            >
              <Icon name="x" size={18} />
            </button>
          </div>
        ) : null}
        <input
          ref={fileInput}
          type="file"
          accept={MEDIA_ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (f) void sendFile(f, isVideoFile(f) ? t('chat.sendingVideo') : t('chat.sendingPhoto'));
          }}
        />
        <input
          ref={viewOnceInput}
          type="file"
          accept="image/*,video/*,audio/*,.heic,.heif"
          hidden
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (f) void sendFile(f, t('chat.sendingViewOnce'), { viewOnce: true });
          }}
        />
        <Menu
          label={t('m.chat.addMenu')}
          icon="plus"
          actions={[
            { label: t('m.chat.poll.new'), icon: 'poll', onSelect: () => setPollOpen(true) },
            { label: t('m.chat.list.new'), icon: 'check-circle', onSelect: () => setListOpen(true) },
            ...(conv && conv.kind !== 'community' ? [{ label: t('m.chat.game.new'), icon: 'game' as const, onSelect: () => setGameStartOpen(true) }] : []),
            ...(conv && conv.kind !== 'community' ? [{ label: t('mixes.shareHere'), icon: 'mix' as const, onSelect: () => setMixShareOpen(true) }] : []),
            // Where you are: live for a while or once (the browser asks for permission only when you tap Share), or ask the others.
            ...(conv && conv.kind !== 'community'
              ? [
                  { label: t('location.menu'), icon: 'map-pin' as const, onSelect: () => setLocationOpen(true) },
                  { label: t('location.ask'), icon: 'compass' as const, onSelect: () => void askLocation() },
                ]
              : []),
          ]}
        />
        <button type="button" className="yp-action" aria-label={t('m.chat.sendPhoto')} disabled={!!uploading} onClick={() => fileInput.current?.click()}>
          <Icon name="image" />
        </button>
        <Menu
          label={t('viewOnce.menu.label')}
          icon="eye"
          actions={[
            { label: t('viewOnce.menu.camera'), icon: 'image', onSelect: () => setCaptureOpen(true) },
            { label: t('viewOnce.menu.voice'), icon: 'mic', onSelect: () => setCaptureMode('voice') },
            { label: t('viewOnce.menu.file'), icon: 'create', onSelect: () => viewOnceInput.current?.click() },
          ]}
        />
        <VoiceRecorder disabled={!!uploading} onError={toast} onRecorded={(f) => void sendFile(f, t('chat.sendingVoice'))} />
        {uploading ? (
          <span className="muted" role="status" style={{ fontSize: 13 }}>
            {uploading}
          </span>
        ) : null}
        <label htmlFor="msg" className="yp-visually-hidden">
          {t('inbox.placeholder')}
        </label>
        <textarea
          ref={composer}
          id="msg"
          rows={1}
          placeholder={t('inbox.placeholder')}
          aria-describedby={replyTo || editing ? 'compose-context' : undefined}
          value={body}
          maxLength={4000}
          onChange={(e) => {
            setBody(e.currentTarget.value);
            if (e.currentTarget.value.trim() && !editing) saidTyping();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
            if (e.key === 'Escape' && (replyTo || editing)) cancelCompose();
          }}
        />
        {!editing ? (
          <button
            type="button"
            className="yp-action"
            aria-label={t('m.chat.later.title')}
            title={t('m.chat.later.title')}
            disabled={!body.trim()}
            onClick={() => {
              setEditingScheduled(null);
              setScheduleOpen(true);
            }}
          >
            <Icon name="clock" />
          </button>
        ) : null}
        <Button type="submit" icon={editing ? 'check' : 'send'} disabled={!body.trim()} aria-label={editing ? t('m.chat.saveEdit') : t('inbox.send')}>
          <span className="chat-send__label">{editing ? t('common.save') : t('inbox.send')}</span>
        </Button>
      </form>
      <ViewOnceCapture
        key={captureStart}
        open={captureOpen}
        initialMode={captureStart}
        onClose={() => {
          setCaptureOpen(false);
          setCaptureStart('photo');
        }}
        onCaptured={(f) => void sendFile(f, t('chat.sendingViewOnce'), { viewOnce: true })}
      />
      <ScheduleSheet
        open={scheduleOpen}
        onClose={() => {
          setScheduleOpen(false);
          setEditingScheduled(null);
        }}
        conversationId={id}
        body={body}
        replyToId={replyTo?.id}
        editing={editingScheduled}
        onDone={(s) => {
          scheduled.setItems((cur) => [...cur.filter((x) => x.id !== s.id), s].sort((a, b) => a.sendAt.localeCompare(b.sendAt)));
          // A new one leaves the message box empty, as sending does.
          if (!editingScheduled) {
            setBody('');
            setReplyTo(null);
          }
        }}
      />
      <ChatLookSheet
        open={lookOpen}
        onClose={() => setLookOpen(false)}
        theme={conv?.theme}
        onPick={async (next) => {
          try {
            const r = await api.conversations.setTheme(id, next);
            setConv((c) => (c ? { ...c, theme: r.theme } : c));
            const line = r.message;
            if (line) addMessage(line);
          } catch (e) {
            toast(errorMessage(e));
          }
        }}
      />
      <ReportSheet target={reportId ? { type: 'message', id: reportId } : null} onClose={() => setReportId(null)} />
      <PollSheet open={pollOpen} onClose={() => setPollOpen(false)} conversationId={id} onSent={addMessage} />
      <ListSheet open={listOpen} onClose={() => setListOpen(false)} conversationId={id} onSent={addMessage} />
      <ShareMixHereSheet open={mixShareOpen} onClose={() => setMixShareOpen(false)} conversationId={id} onSent={addMessage} />
      <ShareLocationSheet
        open={locationOpen}
        onClose={() => setLocationOpen(false)}
        conversationId={id}
        onSent={(m) => {
          addMessage(m);
          if (m.location) sharing.started(m.location);
        }}
      />
      <StartGameSheet
        open={gameStartOpen}
        onClose={() => setGameStartOpen(false)}
        conversation={conv}
        meId={me?.id}
        onSent={(m) => {
          addMessage(m);
          setBoardFor(m.id);
        }}
        onOpenGame={(game) => {
          setLooseGame(messages?.some((m) => m.id === game.messageId) ? null : game);
          setBoardFor(game.messageId);
        }}
      />
      <GameSheet
        game={messages?.find((m) => m.id === boardFor)?.game ?? (looseGame?.messageId === boardFor ? looseGame : null)}
        meId={me?.id}
        onClose={() => setBoardFor(null)}
        onGame={(game) => {
          patchMessage(game.messageId, (x) => ({ ...x, game }));
          setLooseGame((g) => (g && g.id === game.id ? game : g));
        }}
        onRematch={(m) => {
          addMessage(m);
          setBoardFor(m.id);
        }}
      />
      <ReminderSheet
        message={remindFor?.message ?? null}
        scope={remindFor?.scope ?? 'me'}
        onClose={() => setRemindFor(null)}
        onSet={(r) => {
          // Your own reminder shows on the message (the earliest one); the group's shows as a line at its time.
          if (r.scope === 'me')
            patchMessage(r.messageId, (x) => (x.reminder && x.reminder.remindAt <= r.remindAt ? x : { ...x, reminder: { id: r.id, remindAt: r.remindAt } }));
        }}
      />
      <DisappearingSheet
        open={disappearingOpen}
        onClose={() => setDisappearingOpen(false)}
        current={conv?.disappearingSeconds ?? null}
        canChange={canManage}
        onChange={async (seconds) => {
          try {
            const r = await api.conversations.setDisappearing(id, seconds);
            setConv((c) => (c ? { ...c, disappearingSeconds: r.disappearingSeconds } : c));
            const line = r.message;
            if (line) setMessages((cur) => (cur?.some((x) => x.id === line.id) ? cur : [...(cur ?? []), line]));
          } catch (e) {
            toast(errorMessage(e));
          }
        }}
      />
      {conv?.yaps ? (
        <BottomSheet open={yapSettings} onClose={() => setYapSettings(false)} title={t('yap.title')}>
          <div className="stack" style={{ gap: 16 }}>
            <Switch
              label={t('m.yap.outLoud')}
              checked={conv.yaps.playOutLoud ?? conv.yaps.defaultOutLoud}
              onChange={async (on) => {
                try {
                  const { yaps } = await api.conversations.setYaps(id, on);
                  setConv((c) => (c ? { ...c, yaps } : c));
                } catch (e) {
                  toast(errorMessage(e));
                }
              }}
            />
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              {conv.yaps.playOutLoud === null ? (conv.kind === 'direct' ? t('yap.defaultDirect') : t('m.yap.defaultGroup')) : t('m.yap.outLoudHint')}
            </p>
            <Switch
              label={t('m.yap.pause')}
              checked={conv.yaps.paused}
              onChange={async (paused) => {
                try {
                  await api.yaps.setPaused(paused);
                  setConv((c) => (c?.yaps ? { ...c, yaps: { ...c.yaps, paused } } : c));
                } catch (e) {
                  toast(errorMessage(e));
                }
              }}
            />
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              {t('m.yap.quietNote')}
            </p>
          </div>
        </BottomSheet>
      ) : null}
      {conv?.smartReplies ? (
        <BottomSheet open={smartSettings} onClose={() => setSmartSettings(false)} title={t('smartReplies.label')}>
          <div className="stack" style={{ gap: 16 }}>
            <Switch
              label={t('smartReplies.label')}
              checked={conv.smartReplies.setting ?? conv.smartReplies.defaultOn}
              disabled={!conv.smartReplies.everywhere}
              onChange={async (on) => {
                try {
                  const { smartReplies } = await api.conversations.setSmartReplies(id, on);
                  setConv((c) => (c ? { ...c, smartReplies } : c));
                } catch (e) {
                  toast(errorMessage(e));
                }
              }}
            />
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              {t('smartReplies.chatHint')}{' '}
              {!conv.smartReplies.everywhere
                ? t('smartReplies.offEverywhere')
                : conv.smartReplies.setting === null
                  ? t(conv.smartReplies.defaultOn ? 'smartReplies.defaultDirect' : 'smartReplies.defaultGroup')
                  : null}
            </p>
          </div>
        </BottomSheet>
      ) : null}
      <MiniAppsSheet
        open={appsOpen}
        onClose={() => setAppsOpen(false)}
        surface="conversation"
        surfaceId={id}
        onSend={async (text) => {
          await api.conversations.send(id, text, crypto.randomUUID());
        }}
      />
    </div>
  );
}
