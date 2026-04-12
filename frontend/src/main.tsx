import React from 'react'
import ReactDOM from 'react-dom/client'
// ⚠️ Importer api.ts tres tot : il patch window.fetch pour injecter le Bearer
// token automatiquement sur toutes les routes /api/, y compris dans les plugins.
import './core/services/api'
import App from './core/App'
import './core/themes/index.css'
import './i18n'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
