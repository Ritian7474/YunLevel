(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ControlWorkspace = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The kernel still addresses loops by index; UI selection follows their identity.
  class SelectionStore {
    constructor() { this.models = new Map(); }
    update(model, items) {
      const previous = this.models.get(model) || { items: [], key: null };
      const oldIndex = previous.items.findIndex(item => item.key === previous.key);
      const next = items.map(item => ({ ...item }));
      const retained = next.find(item => item.key === previous.key);
      const selected = retained || next[Math.max(0, Math.min(oldIndex, next.length - 1))] || null;
      this.models.set(model, { items: next, key: selected?.key || null });
      return selected;
    }
    select(model, key) {
      const state = this.models.get(model);
      const item = state?.items.find(item => item.key === key);
      if (!item) return null;
      state.key = key;
      return item;
    }
    current(model) {
      const state = this.models.get(model);
      return state?.items.find(item => item.key === state.key) || null;
    }
    clear() { this.models.clear(); }
  }

  function entries(loops, cascades) {
    const occurrences = new Map();
    function entry(kind, value, index) {
      const identity = kind === 'loop' ? `${value.mv}:${value.pv}` : `${value.mv}:${value.outer}:${value.inner}`;
      const base = `${kind}:${identity}`;
      const duplicate = occurrences.get(base) || 0;
      occurrences.set(base, duplicate + 1);
      return { kind, index, key: `${base}:${duplicate}`, value };
    }
    return loops.map((value, index) => entry('loop', value, index))
      .concat(cascades.map((value, index) => entry('casc', value, index)));
  }
  function parameterPolicy(input) {
    const label = input.label || '参数';
    const field = (input.field || '').toLowerCase().replace(/^(outer|inner)/, '');
    if (input.manual) {
      const finite = (raw, fallback) => raw !== '' && raw != null && Number.isFinite(Number(raw)) ? Number(raw) : fallback;
      const min = finite(input.min, 0);
      const max = finite(input.max, 100);
      const step = finite(input.step, 1);
      return { label, min, max, step:step > 0 ? step : 1, hardMin:min, hardMax:max };
    }
    if (field === 'ti') return { label, min:0.1, max:1200, step:0.1, allowInfinity:true };
    if (field === 'kp') return { label, min:0, max:10, step:0.01 };
    if (field === 'td') return { label, min:0, max:300, step:0.1 };
    if (field === 'sp') return label.includes('℃')
      ? { label, min:250, max:650, step:0.1 }
      : { label, min:0, max:100, step:0.1 };
    if (field === 'manualout') return { label, min:0, max:100, step:0.1, hardMin:0, hardMax:100 };
    return null;
  }
  function measurementValue(tag, raw) {
    const suffix = /\(([^)]+)\)\s*$/.exec(tag.label);
    const numeric = (typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')) && Number.isFinite(Number(raw));
    const digits = Number.isInteger(tag.digits) ? Math.max(0, Math.min(6, tag.digits)) : 2;
    return { label:tag.label.replace(/\([^)]*\)\s*$/, '').trim(),
      unit:suffix?.[1] || '', value:numeric ? Number(raw).toFixed(digits) : '—' };
  }
  function fitFrame(viewport, world, zoom) {
    const fit = Math.min(viewport.width / world.width, viewport.height / world.height, 1);
    const scale = fit * zoom;
    return { scale, x:(viewport.width - world.width * scale) / 2, y:(viewport.height - world.height * scale) / 2 };
  }
  function tankLevelGeometry(raw) {
    const numeric = (typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')) && Number.isFinite(Number(raw));
    const height = numeric ? Math.max(0, Math.min(100, Number(raw))) * 1.2 : 0;
    return { y:240 - height, height };
  }
  function pvReadout(catalog, state, digits) {
    const reading = measurementValue({ label:`${catalog.label || 'PV'} (${catalog.unit || ''})`, digits }, state?.[catalog.stateKey]);
    return reading.value === '—' ? '—' : `${reading.value} ${reading.unit}`.trim();
  }
  function criticalReadouts(model, tags, state) {
    const keys = model === 'hx' ? ['ti1104', 'sp', 'ti1103', 'fi1105'] : ['h1', 'h2', 'h3'];
    return keys.map(key => {
      const tag = (tags || []).find(item => item.key === key) || { key, label:key };
      return { key, ...measurementValue(tag, state?.[key]) };
    });
  }
  return { SelectionStore, entries, parameterPolicy, measurementValue, fitFrame, tankLevelGeometry, pvReadout, criticalReadouts };
});
