import { describe, expect, it } from 'vitest';
import { t, tp } from './i18n.ts';
import { callLineText, groupLineText, lastMessageText } from './message-preview.ts';
import type { MessageKey, PluralKey } from './i18n-core.ts';
import type { Message } from './types.ts';

const tr = (locale: string, meId?: string) => ({ t: (key: MessageKey, vars?: Record<string, string | number>) => t(key, locale, vars), locale, meId });
const withTp = (locale: string, meId?: string) => ({ ...tr(locale, meId), tp: (key: PluralKey, count: number) => tp(key, count, locale) });

describe('call lines', () => {
  it('say how a call went, from each side', () => {
    expect(callLineText({ kind: 'video', outcome: 'missed', seconds: null }, 'ada', withTp('en', 'bo'))).toBe('Missed video call');
    expect(callLineText({ kind: 'video', outcome: 'missed', seconds: null }, 'ada', withTp('en', 'ada'))).toBe('Video call, no answer');
    expect(callLineText({ kind: 'audio', outcome: 'declined', seconds: null }, 'ada', withTp('en', 'bo'))).toBe('Audio call declined');
    expect(callLineText({ kind: 'audio', outcome: 'ended', seconds: 20 }, 'ada', withTp('en'))).toBe('Audio call, 1 minute');
    expect(callLineText({ kind: 'audio', outcome: 'ended', seconds: 185 }, 'ada', withTp('en'))).toBe('Audio call, 3 minutes');
    expect(callLineText({ kind: 'video', outcome: 'ended', seconds: 185 }, 'ada', withTp('fr'))).toBe('Appel vidéo, 3 minutes');
  });
});

describe('group lines', () => {
  it('say who changed the group, in the reader’s language', () => {
    const people = [
      { id: 'b', displayName: 'Bo' },
      { id: 'c', displayName: 'Cy' },
    ];
    expect(groupLineText({ action: 'added', people }, 'Ada', tr('en'))).toBe('Ada added Bo and Cy.');
    expect(groupLineText({ action: 'renamed', title: 'Weekend' }, 'Ada', tr('en'))).toBe('Ada renamed the group to Weekend.');
    expect(groupLineText({ action: 'left' }, 'Bo', tr('en'))).toBe('Bo left the group.');
    expect(groupLineText({ action: 'promoted', people: [people[0]!] }, 'Ada', tr('en'))).toBe('Bo is now an admin.');
    expect(groupLineText({ action: 'added', people }, 'Ada', tr('fr'))).toBe('Ada a ajouté Bo et Cy.');
  });

  it('name the reader as “you”', () => {
    expect(groupLineText({ action: 'removed', people: [{ id: 'me', displayName: 'Me' }] }, 'Ada', tr('en', 'me'))).toBe('Ada removed you.');
    expect(groupLineText({ action: 'admin', people: [{ id: 'me', displayName: 'Me' }] }, 'Ada', tr('en', 'me'))).toBe('Ada made you an admin.');
    expect(groupLineText({ action: 'promoted', people: [{ id: 'me', displayName: 'Me' }] }, 'Ada', tr('en', 'me'))).toBe('You’re now an admin.');
  });
});

describe('inbox previews', () => {
  const base = { conversationId: 'c', replyToId: null, attachments: [], createdAt: '2026-09-29T10:00:00.000Z', body: '' };
  const ada = { id: 'ada', username: 'ada', displayName: 'Ada', avatarUrl: null };
  const message = (m: Record<string, unknown>) => ({ ...base, sender: ada, ...m }) as unknown as Message;

  it('say a view-once photo, a yap, a call and a group change in the reader’s language', () => {
    expect(lastMessageText(message({ id: 'v', viewOnce: { state: 'ready', kind: 'image' } }), withTp('en'))).toBe('Photo · View once');
    expect(lastMessageText(message({ id: 'y', kind: 'yap', attachments: [{ kind: 'audio', url: 'x' }] }), withTp('fr'))).toBe(t('m.yap.label', 'fr'));
    const call = message({ id: 'c1', kind: 'system', system: { type: 'call', callId: 'x', kind: 'video', outcome: 'missed', seconds: null } });
    expect(lastMessageText(call, withTp('en', 'bo'))).toBe('Missed video call');
    expect(lastMessageText(call, withTp('ar', 'bo'))).toBe('مكالمة فيديو فائتة');
    expect(lastMessageText(message({ id: 'g', kind: 'system', system: { type: 'group', action: 'left' } }), withTp('fr', 'bo'))).toBe(
      'Ada a quitté le groupe.',
    );
  });
});
