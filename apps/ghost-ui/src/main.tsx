// Global styles load first: they declare the cascade layer order component styles join.
import './ui/styles.css';
import './app.css';
import './pets/pets.css';
import './features/manage.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
