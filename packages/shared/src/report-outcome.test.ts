import { describe, expect, it } from 'vitest';
import { t as translate, type MessageKey } from './i18n.ts';
import { reportOutcome, reportOutcomeText } from './report-outcome.ts';

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
