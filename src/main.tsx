import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';
createRoot(document.getElementById('root')!).render(<React.Suspense fallback={<div className="boot">正在载入工作台…</div>}><App/></React.Suspense>);
