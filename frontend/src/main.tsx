/**
 * Application entry point.
 *
 * Mounts the React application into the ``#root`` div in ``index.html``.
 * React.StrictMode is used in development to detect side effects and
 * deprecated API usage; it renders components twice in dev but not in prod.
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/components.css'
import './styles/animations.css'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
