import { useId, useState } from 'react';
import type { UiChart } from '@ghost/contract';
import { SegmentedControl } from '../../ui';

const colors = ['var(--ghost-ink)', 'var(--ghost-accent-ink)', 'var(--ghost-success)', 'var(--ghost-warning)', 'var(--ghost-danger)', 'var(--ghost-ink2)'];
const number = new Intl.NumberFormat('ko-KR', { maximumSignificantDigits: 6 });
const scientific = new Intl.NumberFormat('ko-KR', { notation: 'scientific', maximumFractionDigits: 2 });

export function ChartBlock({ block }: { block: UiChart }) {
  const [view, setView] = useState<'chart' | 'data'>('chart');
  const titleId = useId();
  const labels = block.series[0].points.map(point => point.label);
  // Normalize before subtracting: even opposite finite extremes must not overflow.
  const scale = Math.max(...block.series.flatMap(series => series.points.map(point => Math.abs(point.value)))) || 1;
  const values = block.series.flatMap(series => series.points.map(point => point.value / scale));
  let low = Math.min(0, ...values);
  let high = Math.max(0, ...values);
  if (low === high) { low = -1; high = 1; }
  const width = Math.max(540, labels.length * 100 + 90);
  const left = 82;
  const right = width - 22;
  const top = 22;
  const bottom = 242;
  const groupWidth = (right - left) / labels.length;
  const x = (index: number) => left + groupWidth * (index + 0.5);
  const y = (value: number) => bottom - (value / scale - low) / (high - low) * (bottom - top);
  const baseline = y(0);
  // Deduplicate actual tick values: subnormal arithmetic can round several ticks alike.
  const ticks = [...new Set(Array.from({ length: 5 }, (_, index) => (low + (high - low) * index / 4) * scale))];
  return <section className="ghost-ui-block" aria-labelledby={titleId}>
    <div className="ghost-ui-block__bar">
      <h3 id={titleId}>{block.title}{block.unit && <span className="ghost-ui-unit"> · {block.unit}</span>}</h3>
      <SegmentedControl aria-label={`${block.title} 보기`} value={view} onValueChange={setView} options={[{ value: 'chart', label: '차트' }, { value: 'data', label: '데이터' }]}/>
    </div>
    {view === 'data' ? <div className="ghost-ui-scroll" role="region" aria-label={`${block.title} 데이터`} tabIndex={0}>
      <table className="ghost-ui-table"><caption className="sr-only">{block.title}{block.unit ? ` (${block.unit})` : ''}</caption>
        <thead><tr><th scope="col">항목</th>{block.series.map(series => <th scope="col" key={series.name}>{series.name}</th>)}</tr></thead>
        <tbody>{labels.map((label, index) => <tr key={label}><th scope="row">{label}</th>{block.series.map(series => <td key={series.name}>{String(series.points[index].value)}</td>)}</tr>)}</tbody>
      </table>
    </div> : <>
      <div className="ghost-ui-scroll" role="region" aria-label={`${block.title} 차트 · 정확한 값은 데이터 보기에서 확인`} tabIndex={0}>
        <svg width={width} height={302} viewBox={`0 0 ${width} 302`} role="img" aria-label={`${block.title}, ${block.kind === 'bar' ? '막대' : '선'} 차트. ${labels.length}개 항목, ${block.series.length}개 계열. 데이터 보기에서 모든 값을 확인할 수 있습니다.`}>
          {ticks.map((tick, index) => <g key={index}>
            <line x1={left} x2={right} y1={y(tick)} y2={y(tick)} stroke="var(--ghost-line)"/>
            <text x={left - 8} y={y(tick) + 4} textAnchor="end" className="ghost-ui-chart__tick">{(Math.abs(tick) >= 1e6 || (tick !== 0 && Math.abs(tick) < 0.001) ? scientific : number).format(tick)}</text>
          </g>)}
          <line x1={left} x2={right} y1={baseline} y2={baseline} stroke="var(--ghost-ink3)"/>
          {labels.map((label, index) => <text key={label} x={x(index)} y={bottom + 24} textAnchor="middle" className="ghost-ui-chart__tick"><title>{label}</title>{label.length > 12 ? `${label.slice(0, 11)}…` : label}</text>)}
          {block.series.map((series, seriesIndex) => <g key={series.name}>
            {block.kind === 'line' && <polyline points={series.points.map((point, index) => `${x(index)},${y(point.value)}`).join(' ')} fill="none" stroke={colors[seriesIndex]} strokeWidth={2} strokeDasharray={seriesIndex ? `${8 - seriesIndex} ${seriesIndex + 2}` : undefined}/>}
            {series.points.map((point, index) => {
              const title = `${point.label} · ${series.name}: ${point.value}${block.unit ? ` ${block.unit}` : ''}`;
              const barWidth = groupWidth * 0.76 / block.series.length;
              return block.kind === 'bar'
                ? <rect key={point.label} x={x(index) - groupWidth * 0.38 + seriesIndex * barWidth} y={Math.min(baseline, y(point.value))} width={Math.max(1, barWidth - 2)} height={Math.abs(y(point.value) - baseline)} fill={colors[seriesIndex]}><title>{title}</title></rect>
                : <circle key={point.label} cx={x(index)} cy={y(point.value)} r={3} fill={colors[seriesIndex]}><title>{title}</title></circle>;
            })}
          </g>)}
        </svg>
      </div>
      <ul className="ghost-ui-legend" aria-label="계열">{block.series.map((series, index) => <li key={series.name}><span aria-hidden="true" style={{ background: colors[index] }}>{index + 1}</span>{series.name}</li>)}</ul>
    </>}
  </section>;
}
