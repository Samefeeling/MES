import { useSupervisorStore } from './store/supervisorStore';

/**
 * MES supplies the operational supervisor gate; SharePoint permissions still enforce access.
 *
 * `hosted` is what makes the gate global: from here on the board neither draws
 * its own lock nor names one, because signing in and out happens once, in the
 * top bar, for every screen of MES at the same time.
 */
export function connectMes(): void {
  if (window.parent === window) return;
  const hostOrigin = new URL(document.baseURI).origin;
  useSupervisorStore.setState({ hosted: true, required: true, unlocked: false });
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== hostOrigin || event.data?.type !== 'mes:assembly-state') return;
    useSupervisorStore.setState({ required: true, unlocked: event.data.supervisor === true });
    document.documentElement.dataset.mesActive = String(event.data.active === true);
  });
  window.parent.postMessage({ type: 'assembly:ready' }, hostOrigin);
}
