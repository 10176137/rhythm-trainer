import { AppTheme } from './components/ui/controls';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import BackendConnectionGate from './components/BackendConnectionGate';
import ErrorBoundary from './components/ErrorBoundary';
import './styles.css';
import './components/ui/theme.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AppTheme><BackendConnectionGate><App /></BackendConnectionGate></AppTheme>
    </ErrorBoundary>
  </React.StrictMode>,
);
