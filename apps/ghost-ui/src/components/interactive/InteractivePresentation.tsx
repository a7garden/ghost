import { useId } from 'react';
import type { InteractiveUi } from '@ghost/contract';
import { MessageBody } from '../MessageBody';
import { ChartBlock } from './ChartBlock';
import { StaticHtmlBlock } from './StaticHtmlBlock';
import { UiInputBlock, type UiSubmit } from './UiInputBlock';
import './interactive.css';

export function InteractivePresentation({ ui, conversationId, messageId, onUiSubmit }: {
  ui: InteractiveUi; conversationId: string; messageId: string; onUiSubmit?: UiSubmit;
}) {
  const titleId = useId();
  return <div className="ghost-interactive" role="group" aria-labelledby={titleId}>
    <h2 id={titleId}>{ui.title}</h2>
    {ui.blocks.map(block => {
      if (block.type === 'text') return <MessageBody key={block.id} text={block.text}/>;
      if (block.type === 'chart') return <ChartBlock key={block.id} block={block}/>;
      if (block.type === 'html') return <StaticHtmlBlock key={block.id} title={block.title} html={block.html}/>;
      if (block.type === 'choices' || block.type === 'form') return <UiInputBlock key={block.id} ui={ui} block={block} conversationId={conversationId} messageId={messageId} onUiSubmit={onUiSubmit}/>;
      return <section className="ghost-ui-block" key={block.id} aria-label={block.title}>
        <h3>{block.title}</h3>
        <div className="ghost-ui-scroll" role="region" aria-label={block.title} tabIndex={0}>
          <table className="ghost-ui-table">
            <caption className="sr-only">{block.title}</caption>
            <thead><tr><th scope="col">항목</th>{block.columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr></thead>
            <tbody>{block.rows.map((row, index) => <tr key={index}><th scope="row">{row.label}</th>{row.values.map((value, column) => <td key={column}>{value}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </section>;
    })}
  </div>;
}
