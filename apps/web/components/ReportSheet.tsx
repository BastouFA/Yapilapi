'use client';

import { useState } from 'react';
import { BottomSheet, Button, Select, TextField } from '@yapilapi/design-system';
import { REPORT_REASONS, type MessageKey } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

const REASON_LABEL: Record<string, MessageKey> = {
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

/** Report something: what's wrong and, if you like, a note. Used for every kind of thing people can report. */
export function ReportSheet({ target, onClose }: { target: { type: string; id: string } | null; onClose: () => void }) {
  const { toast, t } = useSession();
  const [reason, setReason] = useState<string>('spam');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <BottomSheet open={!!target} onClose={onClose} title={t('post.report')}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!target) return;
          setBusy(true);
          try {
            await api.reports.create({ targetType: target.type, targetId: target.id, reason, details: details || undefined });
            toast(t('report.thanks'));
            // The next report starts empty.
            setReason('spam');
            setDetails('');
            onClose();
          } catch (err) {
            toast(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Select label={t('postList.reportWhat')} value={reason} onChange={(e) => setReason(e.currentTarget.value)}>
          {REPORT_REASONS.map((r) => (
            <option key={r} value={r}>
              {REASON_LABEL[r] ? t(REASON_LABEL[r]) : r}
            </option>
          ))}
        </Select>
        <TextField label={t('postList.reportDetails')} multiline value={details} onChange={(e) => setDetails(e.currentTarget.value)} maxLength={2000} />
        <Button type="submit" variant="danger" loading={busy}>
          {t('postList.sendReport')}
        </Button>
      </form>
    </BottomSheet>
  );
}
