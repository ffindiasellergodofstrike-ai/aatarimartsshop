import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import AttireIsolatedCheckout from '../pages/checkout-aatarimart';

declare global {
  interface Window {
    __CHECKOUT__?: Record<string, string>;
  }
}

(function mountPrivateCheckout() {
  const container = document.getElementById('private-checkout-root');
  if (!container) return;

  let bootstrapParams = window.__CHECKOUT__ || {};
  try {
    delete window.__CHECKOUT__;
  } catch {
    window.__CHECKOUT__ = undefined;
  }

  const CTX_KEY = 'attire_checkout_ctx';
  const REF_KEY = 'attire_ref_src';
  try {
    if (typeof bootstrapParams.refSrc === 'string' && bootstrapParams.refSrc.trim()) {
      sessionStorage.setItem(REF_KEY, bootstrapParams.refSrc.trim().slice(0, 200));
    }
    if (bootstrapParams && (bootstrapParams.pkg || bootstrapParams.status)) {
      const cleanCtx: Record<string, string> = {};
      for (const k of ['pkg', 'diamonds', 'uid', 'nick', 'level', 'status']) {
        if (typeof bootstrapParams[k] === 'string' && bootstrapParams[k].length > 0) {
          cleanCtx[k] = bootstrapParams[k];
        }
      }
      bootstrapParams = cleanCtx;
      sessionStorage.setItem(CTX_KEY, JSON.stringify(cleanCtx));
    } else {
      const saved = sessionStorage.getItem(CTX_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') {
          bootstrapParams = parsed;
        }
      }
    }
  } catch {
    // Ignore storage restrictions
  }

  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(bootstrapParams)) {
    if (k !== 'refSrc' && typeof v === 'string' && v.length > 0) {
      sp.set(k, v);
    }
  }

  const initialSearch = sp.toString();
  const initialEntry = '/attirecheckout' + (initialSearch ? `?${initialSearch}` : window.location.search || '');

  createRoot(container).render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AttireIsolatedCheckout />
    </MemoryRouter>
  );
})();
