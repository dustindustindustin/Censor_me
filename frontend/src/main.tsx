/**
 * Application entry point.
 *
 * In Tauri mode, fetches the backend port via IPC before mounting React.
 * In dev mode (no Tauri), mounts immediately (Vite proxy handles routing).
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { reinitAxios, setBackendPort } from './api/client'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/components.css'
import './styles/form-controls.css'
import './styles/animations.css'
import './index.css'

async function bootstrap() {
  // In Tauri mode, get the backend port from the Rust sidecar manager
  if ('__TAURI_INTERNALS__' in window) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const port = await invoke<number>('get_backend_port')
      setBackendPort(port)
      reinitAxios()
    } catch (e) {
      console.warn('Failed to get backend port from Tauri:', e)
    }
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  )
}

bootstrap()
