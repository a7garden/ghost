import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { connectGhostUI, type GhostUI } from '@ghost/ui-sdk';
import './workspace.css';

function Changes({ ghost }: { ghost: GhostUI }) {
  const [show, setShow] = useState(false);
  return <main><h1>Nova 변경 보드</h1>
    <button onClick={() => setShow(value => !value)}>변경 파일 보기</button>
    {show && <p>workspace.tsx · 12줄 추가</p>}
    <button onClick={() => ghost.navigate('checks')}>검증으로 이동</button>
  </main>;
}

function Checks({ ghost }: { ghost: GhostUI }) {
  const [result, setResult] = useState('');
  async function probe() {
    let parentBlocked = false;
    try { void window.parent.document.title; } catch { parentBlocked = true; }
    const requestBlocked = await fetch('/ghost-api/bootstrap').then(() => false, () => true);
    ghost.navigate('settings');
    setResult(parentBlocked && requestBlocked && !('__TAURI_INTERNALS__' in window) ? '프레임 격리 통과' : '프레임 격리 실패');
  }
  return <main><h1>Nova 검증 대시보드</h1>
    <p>접근성 · 반응형 · 실행</p>
    <button onClick={probe}>격리 확인</button>
    {result && <p role="status">{result}</p>}
    <button onClick={() => ghost.navigate('changes')}>변경으로 돌아가기</button>
  </main>;
}

const root = createRoot(document.getElementById('root')!);
void connectGhostUI().then(ghost => root.render(ghost.view.id === 'changes' ? <Changes ghost={ghost}/> : <Checks ghost={ghost}/>));
