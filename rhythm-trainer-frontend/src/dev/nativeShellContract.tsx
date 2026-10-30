// Development-only entry: exercise the real connection gate with the regular
// Vite proxy as the computer address. Not imported by the production entry.
import { Capacitor } from '@capacitor/core';
import ReactDOM from 'react-dom/client';
import App from '../App';
import BackendConnectionGate from '../components/BackendConnectionGate';
import '../styles.css';

Capacitor.isNativePlatform = () => true;
const route = new URLSearchParams(location.search).get('route') ?? '/workbench';
if (['/workbench', '/performance', '/training', '/settings', '/history'].includes(route)) {
  window.history.replaceState(null, '', route);
}
ReactDOM.createRoot(document.getElementById('root')!).render(<BackendConnectionGate><App /></BackendConnectionGate>);
