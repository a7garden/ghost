import { GOAL_SIGNAL_MAX, GOAL_TEXT_MAX } from '@ghost/contract';
import { InlineEdit } from './InlineEdit';
import './goals.css';

export type GoalClauseField = 'why' | 'boundaries' | 'signal';

/** A goal reads as one statement under its direction. Each lead takes no particle, so any phrase the owner writes fits after it. */
export const goalClauses: readonly { field: GoalClauseField; lead: string; label: string; max: number }[] = [
  { field: 'why', lead: '왜냐하면', label: '이유', max: GOAL_TEXT_MAX },
  { field: 'boundaries', lead: '단,', label: '지키는 선', max: GOAL_TEXT_MAX },
  { field: 'signal', lead: '맞다는 신호는', label: '참고 신호', max: GOAL_SIGNAL_MAX },
];

/**
 * The clauses beneath a direction. Read-only shows only what is written; editable shows every clause,
 * an unwritten one as a blank to complete in place.
 */
export function GoalClauses({ value, onSave }: {
  value: Readonly<Record<GoalClauseField, string>>; onSave?(field: GoalClauseField, text: string): Promise<void>;
}) {
  const shown = onSave ? goalClauses : goalClauses.filter(clause => value[clause.field]);
  if (!shown.length) return null;
  return <div className="goal-statement__clauses">
    {shown.map(clause => {
      const lead = <span className="goal-statement__lead">{clause.lead}</span>;
      const text = value[clause.field];
      return <div key={clause.field} className="goal-statement__clause">
        {onSave
          ? <InlineEdit value={text} label={clause.label} name={text ? undefined : `${clause.label} 추가`} prefix={lead} maxLength={clause.max} multiline onSave={next => onSave(clause.field, next)}>
            {text || <span className="goal-statement__blank" aria-hidden="true"/>}
          </InlineEdit>
          : <p>{lead}{text}</p>}
      </div>;
    })}
  </div>;
}
