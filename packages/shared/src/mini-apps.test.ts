import { describe, expect, it } from 'vitest';
import { t as translate, type MessageKey } from './i18n.ts';
import { miniAppNoticeText } from './mini-apps.ts';

describe("telling a developer how their Mini App's review went", () => {
  const t = (key: MessageKey, vars?: Record<string, string | number>) => translate(key, 'en', vars);

  it('says it was approved, with its name', () => {
    expect(miniAppNoticeText({ type: 'mini_app_approved', data: { title: 'Polls+' } }, t)).toBe('Your Mini App “Polls+” was approved. People can add it now.');
  });

  it('gives the reason when the admin gave one', () => {
    expect(miniAppNoticeText({ type: 'mini_app_rejected', data: { title: 'Polls+', reason: 'The address shows an error page.' } }, t)).toBe(
      "Your Mini App “Polls+” wasn't approved: The address shows an error page.",
    );
    expect(miniAppNoticeText({ type: 'mini_app_rejected', data: { title: 'Polls+', reason: null } }, t)).toBe("Your Mini App “Polls+” wasn't approved.");
    expect(miniAppNoticeText({ type: 'mini_app_rejected', data: { title: 'Polls+', reason: '  ' } }, t)).toBe("Your Mini App “Polls+” wasn't approved.");
  });

  it('is in the reader’s language', () => {
    const fr = (key: MessageKey, vars?: Record<string, string | number>) => translate(key, 'fr', vars);
    expect(miniAppNoticeText({ type: 'mini_app_rejected', data: { title: 'Sondages', reason: 'Lien cassé' } }, fr)).toBe(
      'Ta mini-app « Sondages » n’a pas été approuvée : Lien cassé',
    );
  });

  it('leaves other kinds alone', () => {
    expect(miniAppNoticeText({ type: 'ad_rejected', data: { name: 'Ad' } }, t)).toBeNull();
  });
});
