import { describe, expect, it } from 'vitest';
import { classifyText } from './index.js';

describe('rule-based moderation baseline', () => {
  it('approves ordinary content', () => {
    for (const t of [
      'Just landed in Lagos, the food here is unreal',
      'Anyone up for a study group on network security?',
      '',
    ]) {
      expect(classifyText(t)).toMatchObject({ action: 'normal', risk: 'low', status: 'approved' });
    }
  });
  it('escalates direct threats and seed-phrase scams', () => {
    expect(classifyText('I will kill you tomorrow').status).toBe('escalated');
    expect(classifyText('DM me your seed phrase and send it to claim').categories).toContain(
      'scam',
    );
  });
  it('sends medium-risk content to review rather than removing it', () => {
    const r = classifyText('Guaranteed profit! risk-free returns for everyone');
    expect(r.action).toBe('review');
    expect(r.status).toBe('pending_review');
  });
  it('routes self-harm intent to review, never auto-restricting the author', () => {
    const r = classifyText('I want to end my life');
    expect(r.categories).toContain('self_harm');
    expect(r.status).toBe('pending_review');
  });
  it('flags likely card numbers and executable links', () => {
    expect(classifyText('my card 4242 4242 4242 4242 use it').categories).toContain(
      'personal_data',
    );
    expect(classifyText('get it at http://x.example/setup.exe').categories).toContain('malware');
  });
  it('returns explainable signals', () => {
    expect(classifyText('f4f follow back').signals[0]).toMatchObject({
      category: 'spam',
      rule: 'follow_for_follow',
    });
  });
});
