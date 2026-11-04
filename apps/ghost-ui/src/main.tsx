import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { pathToHash } from './client/pathRouting';
import '../tokens.css';
import '@garden/ui/shell.css';
import './styles.css';
import './pets/pets.css';
import './collaboration.css';
import './sidebar.css';
import '../../../tokens.css';
import './liquid-glass.css';
import './docket.css';

// 공유·새로 고친 경로 링크(예: /spaces/notes)를 해시 라우트로 변환해 의도한 화면으로 시작한다.
const bootRoute = pathToHash(location.pathname);
if (bootRoute) history.replaceState(null, '', `/#${bootRoute}`);

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
