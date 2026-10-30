import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import BackendConnectionGate from './components/BackendConnectionGate';
import ErrorBoundary from './components/ErrorBoundary';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BackendConnectionGate><App /></BackendConnectionGate>
    </ErrorBoundary>
  </React.StrictMode>,
);
