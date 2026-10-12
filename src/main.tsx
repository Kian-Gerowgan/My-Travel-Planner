import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { App, StoreProvider } from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StoreProvider><App /></StoreProvider>
  </React.StrictMode>,
);
