import { useLayoutEffect, useRef } from 'react';
import type { CallLevels, CallPhase } from './call-state';

type TurnMode = CallPhase | 'connecting' | 'awaiting-input' | 'awaiting-output' | 'quiet';

// Ghost on the left, owner on the right, like the transcript. Shapes describe
// the phase; only the amplitude of a speech shape comes from the audio meter.
const rest = [3, 3, 3, 3, 3, 3, 3];
const waiting = [3, 3, 15, 15, 3, 3, 3];
const contour: Record<TurnMode, readonly [readonly number[], readonly number[]]> = {
  connecting: [[3, 3, 3, 3, 4, 6, 9], [9, 6, 4, 3, 3, 3, 3]],
  'awaiting-input': [rest, waiting],
  'awaiting-output': [waiting, rest],
  quiet: [rest, rest],
  listening: [rest, [4, 8, 14, 20, 14, 8, 4]],
  hearing: [rest, [13, 23, 36, 22, 29, 16, 8]],
  transcribing: [[4, 16, 4, 16, 4, 16, 4], [4, 4, 4, 4, 9, 9, 9]],
  thinking: [[5, 9, 17, 25, 17, 9, 5], rest],
  working: [[6, 23, 23, 6, 23, 23, 6], rest],
  speaking: [[9, 18, 32, 24, 39, 20, 12], rest],
};

export function TurnSignal({ mode, meter }: { mode: TurnMode; meter: () => CallLevels }) {
  const owner = useRef<SVGGElement>(null);
  const ghost = useRef<SVGGElement>(null);
  useLayoutEffect(() => {
    if (mode !== 'hearing' && mode !== 'speaking') return;
    const channel = mode === 'hearing' ? 'input' : 'output';
    const node = channel === 'input' ? owner.current : ghost.current;
    if (!node) return;
    const style = node.style;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    function draw() {
      const level = meter()[channel];
      style.transform = `scaleY(${.34 + level * .66})`;
      frame = window.requestAnimationFrame(draw);
    }
    function syncMotion() {
      window.cancelAnimationFrame(frame);
      style.removeProperty('transform');
      if (!motion.matches) draw();
    }
    syncMotion();
    motion.addEventListener('change', syncMotion);
    return () => {
      motion.removeEventListener('change', syncMotion);
      window.cancelAnimationFrame(frame);
      style.removeProperty('transform');
    };
  }, [mode, meter]);

  const [output, input] = contour[mode];
  return <svg className="voice-turn-signal" viewBox="0 0 208 48" aria-hidden="true" focusable="false">
    <path className="voice-turn-signal__track" d="M0 24h208" vectorEffect="non-scaling-stroke"/>
    <g className="voice-turn-signal__bank" data-side="ghost" ref={ghost}>
      {output.map((height, index) => <rect key={index} x={12 + index * 9} y={4} width={3} height={40} rx={1.5} style={{ transform: `scaleY(${height / 40})` }}/>)}
    </g>
    <g className="voice-turn-signal__bank" data-side="owner" ref={owner}>
      {input.map((height, index) => <rect key={index} x={139 + index * 9} y={4} width={3} height={40} rx={1.5} style={{ transform: `scaleY(${height / 40})` }}/>)}
    </g>
  </svg>;
}
