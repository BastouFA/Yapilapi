import { describe, expect, it } from 'vitest';
import { t as translate, type MessageKey } from './i18n.ts';
import { appealDecidedText, decisionsFor, reportOutcome, reportOutcomeText } from './report-outcome.ts';

describe('telling reporters the outcome', () => {
  it('says what the reporter can see, never how the other person was penalised', () => {
    expect(reportOutcome('post', 'remove')).toBe('removed');
    expect(reportOutcome('comment', 'restrict')).toBe('removed');
    expect(reportOutcome('post', 'suspend_user')).toBe('actioned');
    expect(reportOutcome('user', 'remove')).toBe('actioned');
    expect(reportOutcome('user', 'suspend_user')).toBe('actioned');
    expect(reportOutcome('message', 'no_action')).toBe('no_violation');
  });

  it('writes a whole sentence for each kind of thing', () => {
    const t = (key: MessageKey, vars?: Record<string, string | number>) => translate(key, 'en', vars);
    const text = (targetType: string, outcome: string) => reportOutcomeText({ type: 'report_outcome', data: { targetType, outcome } }, t);
    expect(text('post', 'removed')).toBe('We reviewed the post you reported and removed it.');
    expect(text('user', 'actioned')).toBe('We reviewed the account you reported and took action.');
    expect(text('comment', 'no_violation')).toBe("We reviewed the comment you reported and it didn't break our rules.");
    expect(text('drop', 'removed')).toBe('We reviewed what you reported and removed it.');
    expect(reportOutcomeText({ type: 'follow', data: {} }, t)).toBeNull();
  });
});

describe('decisions a moderator can make', () => {
  it('fit what was reported', () => {
    // An account is warned or suspended, never "removed" or "limited".
    expect(decisionsFor('user')).toEqual(['no_action', 'warn', 'suspend_user']);
    expect(decisionsFor('post')).toEqual(['no_action', 'warn', 'restrict', 'remove', 'suspend_user']);
    expect(decisionsFor('story')).toContain('restrict');
    // A community or an event has no limited state: it stays up or is removed.
    expect(decisionsFor('community')).toEqual(['no_action', 'warn', 'remove', 'suspend_user']);
    expect(decisionsFor('message')).not.toContain('restrict');
    // A warning reads as action taken to the people who reported it.
    expect(reportOutcome('post', 'warn')).toBe('actioned');
  });

  it("say how an appeal ended, in the reader's language", () => {
    const fr = (key: MessageKey, vars?: Record<string, string | number>) => translate(key, 'fr', vars);
    expect(appealDecidedText({ type: 'appeal_decided', data: { outcome: 'overturned' } }, fr)).toBe(translate('moderation.appeal.overturned', 'fr'));
    expect(appealDecidedText({ type: 'appeal_decided', data: { outcome: 'upheld' } }, fr)).toBe(translate('moderation.appeal.upheld', 'fr'));
    expect(appealDecidedText({ type: 'enforcement', data: {} }, fr)).toBeNull();
  });
});
