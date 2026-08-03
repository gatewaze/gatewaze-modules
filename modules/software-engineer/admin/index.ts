// @ts-nocheck
/**
 * Admin boot side-effects for the software-engineer module. The admin vite plugin side-effect
 * imports any module's admin/index.ts at boot (see vite-plugin-gatewaze-modules.ts) — the sanctioned
 * hook for registering admin-wide contributions.
 *
 * We self-mount the §10.5 "Report feedback" widget into its own React root appended to <body>, so
 * the floating button exists on EVERY admin page without a platform-side contribution point. A
 * separate root keeps it out of the app's tree (no router/provider coupling); the widget itself
 * hides unless the signed-in user passes the SE admin gate.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import ReportFeedbackWidget from './components/ReportFeedbackWidget';

const MOUNT_ID = 'se-report-feedback-root';

function mount() {
  if (typeof document === 'undefined' || document.getElementById(MOUNT_ID)) return;
  const el = document.createElement('div');
  el.id = MOUNT_ID;
  document.body.appendChild(el);
  createRoot(el).render(React.createElement(ReportFeedbackWidget));
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}
