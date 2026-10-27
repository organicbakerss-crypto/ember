import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { appConfig } from '../../../app.config'
import { App } from './App'
import './styles.css'
import { applyInitialTheme } from './useTheme'

document.title = appConfig.name
applyInitialTheme()

// A file dropped anywhere but a drop zone must not replace the page.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (event) => event.preventDefault())
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
