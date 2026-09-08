import { useSupervisorStore } from './store/supervisorStore';

/** MES supplies the operational supervisor gate; SharePoint permissions still enforce access. */
export function connectMes(): void {
  if (window.parent === window) return;
  const hostOrigin = new URL(document.baseURI).origin;
  useSupervisorStore.setState({ required: true, unlocked: false });
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== hostOrigin || event.data?.type !== 'mes:assembly-state') return;
    useSupervisorStore.setState({ required: true, unlocked: event.data.supervisor === true });
    document.documentElement.dataset.mesActive = String(event.data.active === true);
  });
  window.parent.postMessage({ type: 'assembly:ready' }, hostOrigin);
}
