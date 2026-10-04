(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkspaceMotion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const easing = 'cubic-bezier(0.16, 1, 0.3, 1)';

  // Only explicit interactions call this controller; SSE never enters it.
  function create(doc) {
    const preference = doc.defaultView.matchMedia?.('(prefers-reduced-motion: reduce)');
    const active = new Map();
    let destroyed = false;
    function paused() { return destroyed || doc.hidden || !!preference?.matches; }
    function cancel(channel) {
      const previous = active.get(channel);
      if (!previous) return;
      active.delete(channel);
      previous.cancel();
    }
    function cancelAll() { Array.from(active.keys()).forEach(cancel); }
    function updatePreference() {
      doc.documentElement.dataset.motionPaused = String(paused());
      if (paused()) cancelAll();
    }
    function play(channel, target, frames, duration) {
      cancel(channel);
      if (paused() || !target?.isConnected || typeof target.animate !== 'function') return;
      if (target.getClientRects && !target.getClientRects().length) return;
      // CSS owns the final visible state. No fill or inline transform can leak
      // from an interrupted animation into a reused form or popup.
      const animation = target.animate(frames, { duration, easing });
      active.set(channel, animation);
      const settled = () => {
        if (active.get(channel) === animation) active.delete(channel);
      };
      animation.finished.then(settled, settled);
    }
    doc.addEventListener('visibilitychange', updatePreference);
    preference?.addEventListener('change', updatePreference);
    updatePreference();
    return {
      selection(previous, next, target) {
        if (previous === next) return;
        play('selection', target, [
          { transform:'translateX(6px)', opacity:0.75 },
          { transform:'translateX(0)', opacity:1 },
        ], 160);
      },
      slider(target) {
        play('slider', target, [
          { transform:'scale(0.985)', opacity:0.8 },
          { transform:'scale(1)', opacity:1 },
        ], 120);
      },
      confirm(target) {
        play(target, target, [
          { backgroundColor:'rgba(51, 205, 166, 0.16)' },
          { backgroundColor:'rgba(51, 205, 166, 0)' },
        ], 180);
      },
      cancel,
      destroy() {
        destroyed = true;
        cancelAll();
        doc.removeEventListener('visibilitychange', updatePreference);
        preference?.removeEventListener('change', updatePreference);
        updatePreference();
      },
    };
  }
  return { create };
});
