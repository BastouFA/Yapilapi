/**
 * The moderation pipeline as a pure model:
 *   Content -> Analysis -> Risk -> (Normal | Review | Restrict | Escalate) -> Appeal -> Final
 * A case row stores only its current `state`; this module derives the full path for staff UIs and tests, and defines
 * which transitions are legal so no code path can, for example, decide an already-final case.
 */

export type CaseState = 'normal' | 'review' | 'restricted' | 'escalated' | 'appealed' | 'resolved';
export type PipelineStage =
  | 'content'
  | 'analysis'
  | 'risk'
  | 'normal'
  | 'review'
  | 'restrict'
  | 'escalate'
  | 'appeal'
  | 'final';

const BRANCH: Record<Exclude<CaseState, 'appealed' | 'resolved'>, PipelineStage> = {
  normal: 'normal',
  review: 'review',
  restricted: 'restrict',
  escalated: 'escalate',
};

export interface PipelineView {
  current: PipelineStage;
  /** Stages this case has passed through, oldest first, ending with `current`. */
  path: PipelineStage[];
}

export function pipelineFor(c: { state: CaseState; decided: boolean }): PipelineView {
  const head: PipelineStage[] = ['content', 'analysis', 'risk'];
  switch (c.state) {
    case 'normal':
    case 'review':
    case 'restricted':
    case 'escalated':
      return { current: BRANCH[c.state], path: [...head, BRANCH[c.state]] };
    case 'appealed':
      return { current: 'appeal', path: [...head, 'review', 'appeal'] };
    case 'resolved':
      // A decided case went through human review; an undecided resolved case was cleared as normal.
      return { current: 'final', path: [...head, c.decided ? 'review' : 'normal', 'final'] };
  }
}

const TRANSITIONS: Record<CaseState, CaseState[]> = {
  normal: ['review', 'resolved'],
  review: ['restricted', 'escalated', 'resolved'],
  restricted: ['review', 'escalated', 'resolved'],
  escalated: ['review', 'resolved'],
  appealed: ['resolved'],
  resolved: ['appealed'],
};

export const canTransition = (from: CaseState, to: CaseState): boolean =>
  from === to || TRANSITIONS[from].includes(to);
