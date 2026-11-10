import { mount } from 'svelte';
import './ui/theme.css';
import App from './App.svelte';
import { diagnostics } from './lib/diagnostics.svelte';
import { ipc } from './lib/ipc';

if (import.meta.env.PROD) {
  diagnostics.installGlobalHooks();
  diagnostics.attachEngine((cb) => ipc.onEngineEvent(cb));
}

const app = mount(App, { target: document.getElementById('app')! });

export default app;
