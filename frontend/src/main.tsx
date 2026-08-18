import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Prevent native browser auto-scroll on textarea focus
// This fixes Fabric.js text editing causing the viewport to jump wildly
const originalFocus = HTMLTextAreaElement.prototype.focus;
HTMLTextAreaElement.prototype.focus = function(options) {
  originalFocus.call(this, { preventScroll: true, ...options });
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
