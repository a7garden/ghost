import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import '@garden/ui/styles.css';
import './app.css';
import './pets/pets.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
