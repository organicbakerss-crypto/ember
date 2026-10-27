import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { appConfig } from '../../../app.config'
import { App } from './App'
import './styles.css'

document.title = appConfig.name

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
