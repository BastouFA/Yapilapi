import { useId, useState } from 'react';
import { Button } from '../components/primitives';
import { Checkbox, RadioGroup, Radio } from '../components/form';
import { CheckIcon } from '../components/icons';
import { useUI } from '../context';
import { formatDateTime, formatNumber } from '../format';
import { cx } from '../utils';
import type { PollData } from './types';

export interface PollLabels {
  vote: string;
  voting: string;
  chooseOne: string;
  chooseMany: string;
  votesTotal: (n: number) => string;
  closesAt: (when: string) => string;
  closed: string;
  yourVote: string;
  pickAtLeastOne: string;
}

export interface PollViewProps {
  poll: PollData;
  labels: PollLabels;
  /** Resolve with the updated poll (or void); reject to show an error via the caller's own UI. */
  onVote: (optionIds: string[]) => Promise<void>;
  now?: number;
  className?: string;
}

/** A poll: choose then vote, or see results (after voting, or when closed). Results are announced politely. */
export function PollView({ poll, labels, onVote, now = Date.now(), className }: PollViewProps) {
  const { locale } = useUI();
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [needChoice, setNeedChoice] = useState(false);
  const qid = useId();
  const closed = poll.closesAt !== null && new Date(poll.closesAt).getTime() <= now;
  const voted = poll.myVotes.length > 0;
  const showResults = voted || closed;

  const submit = async () => {
    if (picked.length === 0) {
      setNeedChoice(true);
      return;
    }
    setNeedChoice(false);
    setBusy(true);
    try {
      await onVote(picked);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cx('yl-poll', className)}>
      <p id={qid} className="yl-poll__q">
        {poll.question}
      </p>
      {showResults ? (
        <ul className="yl-poll__results" aria-labelledby={qid} aria-live="polite">
          {poll.options.map((o) => {
            const pct = poll.totalVotes > 0 ? o.votes / poll.totalVotes : 0;
            const mine = poll.myVotes.includes(o.id);
            return (
              <li key={o.id} className={cx('yl-poll__result', mine && 'is-mine')}>
                <div className="yl-poll__row">
                  <span className="yl-poll__label">
                    {o.label}
                    {mine ? (
                      <span className="yl-poll__mine">
                        <CheckIcon size={14} />
                        <span className="yl-sr-only">{labels.yourVote}</span>
                      </span>
                    ) : null}
                  </span>
                  <span className="yl-poll__pct">
                    {formatNumber(pct, locale, { style: 'percent', maximumFractionDigits: 0 })}
                  </span>
                </div>
                <progress
                  className="yl-poll__bar"
                  value={o.votes}
                  max={Math.max(poll.totalVotes, 1)}
                  aria-label={`${o.label}: ${formatNumber(pct, locale, { style: 'percent', maximumFractionDigits: 0 })}`}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="yl-poll__form"
        >
          {poll.multiple ? (
            <fieldset className="yl-radiogroup">
              <legend className="yl-sr-only">{labels.chooseMany}</legend>
              <div className="yl-radiogroup__items">
                {poll.options.map((o) => (
                  <Checkbox
                    key={o.id}
                    label={o.label}
                    checked={picked.includes(o.id)}
                    onChange={(e) =>
                      setPicked((p) =>
                        e.target.checked ? [...p, o.id] : p.filter((x) => x !== o.id),
                      )
                    }
                  />
                ))}
              </div>
            </fieldset>
          ) : (
            <RadioGroup
              legend={labels.chooseOne}
              hideLegend
              value={picked[0]}
              onValueChange={(v) => setPicked([v])}
            >
              {poll.options.map((o) => (
                <Radio key={o.id} value={o.id} label={o.label} />
              ))}
            </RadioGroup>
          )}
          {needChoice ? (
            <p className="yl-field__error" role="alert">
              {labels.pickAtLeastOne}
            </p>
          ) : null}
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            loading={busy}
            loadingLabel={labels.voting}
          >
            {labels.vote}
          </Button>
        </form>
      )}
      <p className="yl-poll__meta">
        <span>{labels.votesTotal(poll.totalVotes)}</span>
        <span aria-hidden="true"> · </span>
        <span>
          {closed
            ? labels.closed
            : poll.closesAt
              ? labels.closesAt(formatDateTime(poll.closesAt, locale))
              : ''}
        </span>
      </p>
    </div>
  );
}
