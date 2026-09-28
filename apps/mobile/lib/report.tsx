import { useCallback, useState } from 'react';
import { AccessibilityInfo, Text, View } from 'react-native';
import { ApiError } from '../../../packages/api-client/src/index';
import { REPORT_REASONS, REPORT_TARGETS } from '../../../packages/shared/src/constants';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import { client, errorMessage } from './api';
import { useT } from './i18n';
import { useSession } from './session';
import { space } from './theme';
import { BottomSheet, Button, Field, Icon, Notice, SheetItem, SwitchRow, useColors } from './ui';

export type ReportTargetType = (typeof REPORT_TARGETS)[number];
export type ReportReason = (typeof REPORT_REASONS)[number];

/**
 * What is being reported. `authorId` and `authorName` are whoever wrote or owns it (the person
 * for a profile): with both, and when it isn't the viewer, the sheet offers to block them too.
 */
export interface ReportTarget {
  type: ReportTargetType;
  id: string;
  authorId?: string;
  authorName?: string;
}

/** The label of each report reason (the same words as the web). */
export const REASON_KEYS: Record<ReportReason, MessageKey> = {
  spam: 'postList.reason.spam',
  harassment: 'postList.reason.harassment',
  hate: 'postList.reason.hate',
  violence: 'postList.reason.violence',
  nudity: 'postList.reason.nudity',
  self_harm: 'postList.reason.selfHarm',
  impersonation: 'postList.reason.impersonation',
  fraud: 'postList.reason.fraud',
  minor_safety: 'postList.reason.minorSafety',
  copyright: 'postList.reason.copyright',
  other: 'postList.reason.other',
};

const TITLE_KEYS: Record<ReportTargetType, MessageKey> = {
  user: 'm.report.title.user',
  post: 'm.report.title.post',
  comment: 'm.report.title.comment',
  message: 'm.report.title.message',
  community: 'm.report.title.community',
  event: 'm.report.title.event',
  product: 'm.report.title.product',
  story: 'm.report.title.story',
  room: 'm.report.title.room',
  live: 'm.report.title.live',
  question: 'm.report.title.question',
  answer: 'm.report.title.answer',
  drop: 'm.report.title.drop',
  mix: 'm.report.title.mix',
};

type Done = { already: boolean; blocked: boolean; blockError?: string };

/**
 * Report something: choose what's wrong, add a note if you like, block the person too if you
 * want, and send. Then it says what happens next (or that you already reported it). Use
 * `useReport()` to open it from a menu.
 */
export function ReportSheet({
  target,
  visible,
  onClose,
  onBlocked,
}: {
  target: ReportTarget;
  visible: boolean;
  onClose: () => void;
  /** After the person was blocked from here (a screen can hide what they wrote). */
  onBlocked?: (userId: string) => void;
}) {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [block, setBlock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const author = target.authorId && target.authorName && target.authorId !== me?.id ? { id: target.authorId, name: target.authorName } : null;
  const title = target.type === 'user' && target.authorName ? t('m.profile.reportTitle', { name: target.authorName }) : t(TITLE_KEYS[target.type]);

  async function send() {
    if (!reason || busy) return;
    setBusy(true);
    setError(null);
    try {
      const api = await client();
      let already = false;
      try {
        await api.reports.create({ targetType: target.type, targetId: target.id, reason, details: details.trim() || undefined });
      } catch (e) {
        // Already reported: say so, and still block if that was asked for.
        if (e instanceof ApiError && e.status === 409) already = true;
        else throw e;
      }
      const result: Done = { already, blocked: false };
      if (author && block) {
        try {
          await api.users.block(author.id);
          result.blocked = true;
          onBlocked?.(author.id);
        } catch (e) {
          result.blockError = errorMessage(e);
        }
      }
      setDone(result);
      AccessibilityInfo.announceForAccessibility(already ? t('m.report.alreadyTitle') : t('m.report.doneTitle'));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <BottomSheet visible={visible} title={title} onClose={onClose}>
        <View style={{ alignItems: 'center', gap: space[2], paddingVertical: space[2] }}>
          <Icon name={done.already ? 'information-circle-outline' : 'checkmark-circle-outline'} size={40} color={c.yapi} />
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '700', textAlign: 'center' }}>
            {done.already ? t('m.report.alreadyTitle') : t('m.report.doneTitle')}
          </Text>
          <Text style={{ color: c.inkMuted, lineHeight: 20, textAlign: 'center' }}>{done.already ? t('m.report.alreadyBody') : t('m.report.doneBody')}</Text>
          {done.blocked && author ? (
            <Text style={{ color: c.ink, fontWeight: '600', textAlign: 'center' }}>{t('m.profile.blocked', { name: author.name })}</Text>
          ) : null}
        </View>
        {done.blockError ? <Notice tone="danger">{done.blockError}</Notice> : null}
        <Button label={t('m.common.done')} onPress={onClose} />
      </BottomSheet>
    );

  return (
    <BottomSheet visible={visible} title={title} subtitle={t('m.report.private')} onClose={onClose}>
      <Text accessibilityRole="header" style={{ color: c.inkMuted, fontWeight: '700', fontSize: 13 }}>
        {t('postList.reportWhat')}
      </Text>
      <View accessibilityRole="radiogroup" style={{ gap: 2 }}>
        {REPORT_REASONS.map((r) => (
          <SheetItem
            key={r}
            icon={reason === r ? 'radio-button-on' : 'radio-button-off'}
            label={t(REASON_KEYS[r])}
            selected={reason === r}
            onPress={() => setReason(r)}
          />
        ))}
      </View>
      <Field
        label={t('postList.reportDetails')}
        value={details}
        onChangeText={setDetails}
        multiline
        maxLength={2000}
        style={{ minHeight: 88, paddingTop: space[2], textAlignVertical: 'top' }}
      />
      {author ? <SwitchRow label={t('m.report.block', { name: author.name })} hint={t('m.profile.blockBody')} value={block} onValueChange={setBlock} /> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button label={busy ? t('ds.sending') : t('postList.sendReport')} variant="danger" disabled={!reason || busy} onPress={() => send()} />
    </BottomSheet>
  );
}

/**
 * `const report = useReport()`, then `report.open({ type: 'post', id, authorId, authorName })`
 * from a menu and `{report.sheet}` somewhere in what the component renders. From an ActionSheet
 * action it can open straight away (the action runs once the menu has gone).
 */
export function useReport(opts?: { onBlocked?: (userId: string) => void }) {
  const [target, setTarget] = useState<ReportTarget | null>(null);
  const [open, setOpenState] = useState(false);
  // A fresh sheet each time it opens, even for the same thing.
  const [round, setRound] = useState(0);
  const show = useCallback((next: ReportTarget) => {
    setTarget(next);
    setRound((n) => n + 1);
    setOpenState(true);
  }, []);
  const close = useCallback(() => setOpenState(false), []);
  // The last sheet stays rendered while it slides away.
  const sheet = target ? <ReportSheet key={round} target={target} visible={open} onClose={close} onBlocked={opts?.onBlocked} /> : null;
  return { open: show, close, isOpen: open, sheet };
}
