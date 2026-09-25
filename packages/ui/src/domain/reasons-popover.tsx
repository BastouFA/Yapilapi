import { useCallback, useState } from 'react';
import { Popover } from '../components/popover';
import { Button, Skeleton } from '../components/primitives';
import { SparkIcon } from '../components/icons';
import type { FeedbackAction } from './types';

export interface ReasonsLabels {
  trigger: string;
  title: string;
  intro: string;
  loading: string;
  error: string;
  retry: string;
  controlsTitle: string;
  moreLikeThis: string;
  lessLikeThis: string;
  notInterested: string;
  muteCreator: string;
  done: string;
  feedbackSent: string;
}

export interface ReasonsPopoverProps {
  labels: ReasonsLabels;
  /** Fetch the reasons the ranker gave for this post (localise them in the caller). */
  load: () => Promise<string[]>;
  onFeedback?: (a: FeedbackAction) => Promise<void> | void;
  postId: string;
}

/** "Why am I seeing this?": fetches the real explanation when opened and offers direct feedback controls. */
export function ReasonsPopover({ labels, load, onFeedback, postId }: ReasonsPopoverProps) {
  const [state, setState] = useState<{
    status: 'idle' | 'loading' | 'ready' | 'error';
    reasons: string[];
  }>({ status: 'idle', reasons: [] });
  const [sent, setSent] = useState(false);

  const fetchReasons = useCallback(async () => {
    setState({ status: 'loading', reasons: [] });
    try {
      setState({ status: 'ready', reasons: await load() });
    } catch {
      setState({ status: 'error', reasons: [] });
    }
  }, [load]);

  const send = async (a: FeedbackAction) => {
    await onFeedback?.(a);
    setSent(true);
  };

  return (
    <Popover
      label={labels.title}
      align="end"
      triggerClassName="yl-reasons-trigger"
      triggerProps={{ 'data-testid': `why-${postId}` }}
      triggerContent={
        <>
          <SparkIcon size={16} />
          <span>{labels.trigger}</span>
        </>
      }
      onOpenChange={(o) => {
        if (o) {
          setSent(false);
          void fetchReasons();
        }
      }}
    >
      {({ close }) => (
        <div className="yl-reasons">
          <h3 className="yl-reasons__title">{labels.title}</h3>
          <p className="yl-reasons__intro">{labels.intro}</p>
          <div aria-live="polite" aria-busy={state.status === 'loading'}>
            {state.status === 'loading' ? (
              <div className="yl-reasons__loading">
                <span className="yl-sr-only">{labels.loading}</span>
                <Skeleton width="full" />
                <Skeleton width="md" />
              </div>
            ) : null}
            {state.status === 'error' ? (
              <p className="yl-reasons__error" role="alert">
                {labels.error}{' '}
                <Button size="sm" variant="ghost" onClick={() => void fetchReasons()}>
                  {labels.retry}
                </Button>
              </p>
            ) : null}
            {state.status === 'ready' ? (
              <ul className="yl-reasons__list">
                {state.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            ) : null}
          </div>
          {onFeedback ? (
            <div className="yl-reasons__controls" role="group" aria-label={labels.controlsTitle}>
              <p className="yl-reasons__controls-title">{labels.controlsTitle}</p>
              <div className="yl-reasons__buttons">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void send({ type: 'more_like_this' })}
                >
                  {labels.moreLikeThis}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void send({ type: 'less_like_this' })}
                >
                  {labels.lessLikeThis}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void send({ type: 'not_interested' })}
                >
                  {labels.notInterested}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void send({ type: 'mute_creator' })}
                >
                  {labels.muteCreator}
                </Button>
              </div>
              <p className="yl-reasons__sent" role="status">
                {sent ? labels.feedbackSent : ''}
              </p>
            </div>
          ) : null}
          <div className="yl-reasons__footer">
            <Button size="sm" variant="ghost" onClick={close}>
              {labels.done}
            </Button>
          </div>
        </div>
      )}
    </Popover>
  );
}
