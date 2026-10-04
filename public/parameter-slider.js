(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ParameterSlider = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  let nextId = 0;
  const numeric = value => value !== null && value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  // Soft limits grow to include a typed value. Hard limits constrain only the
  // slider; callers keep the original source text for their existing validation.
  function rangeFor(policy = {}, rawValue, rememberedFinite) {
    const step = numeric(policy.step) && Number(policy.step) > 0 ? Number(policy.step) : 1;
    const allowInfinity = !!policy.allowInfinity;
    const hardMin = numeric(policy.hardMin) ? Number(policy.hardMin) : -Infinity;
    const hardMax = numeric(policy.hardMax) ? Number(policy.hardMax) : Infinity;
    const lower = allowInfinity ? Math.max(Number.MIN_VALUE, hardMin) : hardMin;
    if (hardMax < lower) throw new RangeError('ParameterSlider requires an available finite range');

    let min = numeric(policy.min) ? Number(policy.min) : (allowInfinity ? step : 0);
    let max = numeric(policy.max) ? Number(policy.max) : 100;
    if (allowInfinity && min <= 0) min = step;
    if (max < min) max = min;
    min = clamp(min, lower, hardMax);
    max = clamp(max, min, hardMax);

    const text = String(rawValue ?? '').trim();
    const parsed = numeric(text) ? Number(text) : null;
    const infinity = allowInfinity && (/^(inf|∞)$/i.test(text) || (parsed !== null && parsed < 0));
    const invalid = !infinity && (parsed === null || (allowInfinity && parsed <= 0));
    const finiteValue = invalid || infinity ? null : parsed;
    const outOfBounds = finiteValue !== null && (finiteValue < lower || finiteValue > hardMax);
    const memory = numeric(rememberedFinite) && (!allowInfinity || Number(rememberedFinite) > 0)
      ? clamp(Number(rememberedFinite), lower, hardMax) : min;
    const restored = finiteValue !== null && !outOfBounds ? finiteValue : memory;
    const value = clamp(finiteValue === null ? restored : finiteValue, lower, hardMax);
    min = Math.min(min, value);
    max = Math.max(max, value);
    return { min, max, step, value, finiteValue, rememberedFinite: restored, infinity, invalid, outOfBounds };
  }

  function bind(doc, options = {}) {
    if (!doc || !doc.addEventListener || typeof options.getPolicy !== 'function') {
      throw new TypeError('ParameterSlider.bind requires a document and getPolicy(input)');
    }
    const view = doc.defaultView;
    const selector = options.selector || 'input[type="number"]';
    const memories = new WeakMap();
    const id = 'parameter-slider-' + (++nextId);
    const panel = doc.createElement('div');
    panel.id = id;
    panel.className = 'parameter-slider';
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-labelledby', id + '-title');
    panel.hidden = true;
    panel.innerHTML = '<div class="parameter-slider-head"><label id="' + id + '-title" for="' + id + '-range"></label>' +
      '<output for="' + id + '-range"></output></div>' +
      '<input id="' + id + '-range" class="parameter-slider-range" type="range">' +
      '<div class="parameter-slider-bounds" aria-hidden="true"><span></span><span></span></div>' +
      '<label class="parameter-slider-infinity"><input type="checkbox"><span>关闭积分（inf）</span></label>' +
      '<p class="parameter-slider-status" id="' + id + '-status" role="status"></p>' +
      '<p class="parameter-slider-hint" id="' + id + '-hint">仅修改草稿，应用后生效。</p>' +
      '<button type="button" class="parameter-slider-close" aria-label="关闭滑块" title="关闭滑块"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button>';
    const title = panel.querySelector('.parameter-slider-head label');
    const output = panel.querySelector('output');
    const slider = panel.querySelector('input[type="range"]');
    const infinityLabel = panel.querySelector('.parameter-slider-infinity');
    const infinityBox = panel.querySelector('input[type="checkbox"]');
    const bounds = panel.querySelectorAll('.parameter-slider-bounds span');
    const status = panel.querySelector('.parameter-slider-status');
    const closeButton = panel.querySelector('button');
    slider.setAttribute('aria-describedby', id + '-status ' + id + '-hint');
    let source = null;
    let state = null;
    let observer = null;
    let frame = null;
    let suppressFocus = false;
    let destroyed = false;
    let originalAria = null;

    function matches(input) {
      return input && input.nodeType === 1 && input.tagName === 'INPUT' && !panel.contains(input) && input.matches(selector);
    }

    function visible(element) {
      if (!element || !element.isConnected || !doc.documentElement.contains(element)) return false;
      for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
        if (node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true') return false;
        const style = view.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      }
      return element.getClientRects().length > 0;
    }

    function editable(input) {
      return matches(input) && !input.disabled && !input.readOnly && !input.matches(':disabled') && visible(input);
    }

    function policyFor(input) {
      return options.getPolicy(input) || null;
    }

    function remember(input, policy) {
      const next = rangeFor(policy, input.value, memories.get(input));
      if (next.finiteValue !== null && !next.outOfBounds) memories.set(input, next.finiteValue);
      return next;
    }

    function focusSource(input) {
      if (!editable(input)) return;
      suppressFocus = true;
      try { input.focus({ preventScroll: true }); }
      finally { suppressFocus = false; }
    }

    // close(true) may restore focus; suppressFocus keeps Escape from reopening.
    function close(restoreFocus = false) {
      options.motion?.cancel('slider');
      const oldSource = source;
      source = null;
      state = null;
      if (observer) observer.disconnect();
      observer = null;
      if (frame !== null) view.cancelAnimationFrame(frame);
      frame = null;
      panel.hidden = true;
      panel.remove();
      if (oldSource && originalAria) {
        for (const [name, value] of Object.entries(originalAria)) {
          if (value === null) oldSource.removeAttribute(name);
          else oldSource.setAttribute(name, value);
        }
      }
      originalAria = null;
      if (restoreFocus && oldSource) focusSource(oldSource);
    }

    function position() {
      frame = null;
      if (!source) return;
      if (!editable(source)) { close(); return; }
      const viewport = view.visualViewport;
      const width = viewport ? viewport.width : view.innerWidth;
      const height = viewport ? viewport.height : view.innerHeight;
      const x = viewport ? viewport.offsetLeft : 0;
      const y = viewport ? viewport.offsetTop : 0;
      const margin = Math.min(8, width / 4, height / 4);
      panel.style.width = Math.max(0, Math.min(320, width - margin * 2)) + 'px';
      panel.style.maxHeight = Math.max(0, height - margin * 2) + 'px';
      const rect = source.getBoundingClientRect();
      const box = panel.getBoundingClientRect();
      const below = rect.bottom + 8;
      const above = rect.top - box.height - 8;
      // Keep the apply buttons below the source available whenever there is room.
      const preferred = above >= y + margin ? above
        : below + box.height <= y + height - margin ? below
          : y + height - rect.bottom >= rect.top - y ? below : above;
      panel.style.left = clamp(rect.left, x + margin, Math.max(x + margin, x + width - box.width - margin)) + 'px';
      panel.style.top = clamp(preferred, y + margin, Math.max(y + margin, y + height - box.height - margin)) + 'px';
      panel.style.visibility = 'visible';
    }

    function schedulePosition() {
      if (source && frame === null) frame = view.requestAnimationFrame(position);
    }

    function sync() {
      if (!source) return;
      if (!editable(source)) { close(); return; }
      const policy = policyFor(source);
      if (!policy) { close(); return; }
      // Keep an expanded soft range stable while dragging. Reopening starts
      // from the policy and the current draft again.
      const activePolicy = state ? {
        ...policy,
        min: Math.min(numeric(policy.min) ? Number(policy.min) : state.min, state.min),
        max: Math.max(numeric(policy.max) ? Number(policy.max) : state.max, state.max)
      } : policy;
      state = remember(source, activePolicy);
      title.textContent = String(policy.label || '参数');
      slider.min = String(state.min);
      slider.max = String(state.max);
      slider.step = String(state.step);
      slider.value = String(state.value);
      slider.disabled = state.infinity || state.min === state.max;
      output.textContent = state.infinity ? 'inf · 积分已关闭' : source.value.trim() || '—';
      bounds[0].textContent = String(state.min);
      bounds[1].textContent = String(state.max);
      infinityLabel.hidden = !policy.allowInfinity;
      infinityBox.checked = state.infinity;
      status.textContent = state.outOfBounds ? '输入超出可选范围；原值保留在输入框中。'
        : state.invalid ? (policy.allowInfinity ? '请填写有限正数或 inf；输入框仍可编辑。' : '请在输入框中填写有效数字。') : '';
      panel.classList.toggle('parameter-slider-has-status', !!status.textContent);
      schedulePosition();
    }

    function watch() {
      if (!view.MutationObserver || !source) return;
      observer = new view.MutationObserver(() => {
        if (!source) return;
        // Observe only the active input and its ancestor path. Live readings
        // elsewhere in the document do not cause slider work on every SSE tick.
        sync();
      });
      for (let node = source; node && node.nodeType === 1; node = node.parentElement) {
        observer.observe(node, {
          attributes: true,
          attributeFilter: ['class', 'disabled', 'readonly', 'hidden', 'style', 'inert', 'aria-hidden', 'value'],
          childList: true
        });
      }
    }

    function open(input) {
      if (destroyed || !editable(input) || !policyFor(input)) return;
      if (source === input) { sync(); return; }
      close();
      source = input;
      originalAria = {};
      for (const name of ['aria-controls', 'aria-expanded', 'aria-describedby']) originalAria[name] = input.getAttribute(name);
      input.setAttribute('aria-controls', [originalAria['aria-controls'], id].filter(Boolean).join(' '));
      input.setAttribute('aria-expanded', 'true');
      input.setAttribute('aria-describedby', [originalAria['aria-describedby'], id + '-hint'].filter(Boolean).join(' '));
      panel.style.visibility = 'hidden';
      panel.hidden = false;
      doc.body.appendChild(panel);
      sync();
      position();
      options.motion?.slider(panel);
      watch();
    }

    function write(value) {
      if (!source || !editable(source) || !policyFor(source)) { close(); return; }
      const input = source;
      input.value = String(value);
      input.dispatchEvent(new view.Event('input', { bubbles: true }));
      if (source === input) sync();
    }

    function onPointer(event) {
      if (panel.contains(event.target)) return;
      if (editable(event.target) && policyFor(event.target)) open(event.target);
      else close();
    }

    function onFocus(event) {
      if (suppressFocus || panel.contains(event.target)) return;
      if (editable(event.target) && policyFor(event.target)) open(event.target);
      else close();
    }

    function onInput(event) {
      if (!matches(event.target)) return;
      const policy = policyFor(event.target);
      if (policy) remember(event.target, policy);
      if (event.target === source) sync();
    }

    function panelControls() {
      return Array.from(panel.querySelectorAll('input,button')).filter(control => !control.disabled && visible(control));
    }

    function nextControl(input) {
      const all = Array.from(doc.querySelectorAll('a[href],button,input,select,textarea,[tabindex]'))
        .filter(control => control.tabIndex >= 0 && !control.matches(':disabled') && !panel.contains(control) && visible(control));
      return all[all.indexOf(input) + 1] || null;
    }

    function onKey(event) {
      if (!source) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close(true);
        return;
      }
      // The body portal remains beside its input in the keyboard sequence.
      // No focus trap: Tab from its last control continues after the input.
      if (event.key !== 'Tab') return;
      const controls = panelControls();
      if (event.target === source && !event.shiftKey && controls.length) {
        event.preventDefault();
        controls[0].focus();
      } else if (event.target === controls[0] && event.shiftKey) {
        event.preventDefault();
        focusSource(source);
      } else if (event.target === controls[controls.length - 1] && !event.shiftKey) {
        const next = nextControl(source);
        if (next) {
          event.preventDefault();
          close();
          next.focus();
        }
      }
    }

    slider.addEventListener('input', () => {
      if (!state || slider.disabled) return;
      write(slider.value);
    });
    infinityBox.addEventListener('change', () => {
      if (!source || !state) return;
      const policy = policyFor(source);
      if (!policy || !policy.allowInfinity) { sync(); return; }
      write(infinityBox.checked ? 'inf' : state.rememberedFinite);
    });
    closeButton.addEventListener('click', () => close(true));
    for (const name of ['pointerdown', 'pointermove', 'mousedown', 'touchstart', 'click', 'keydown']) {
      panel.addEventListener(name, event => event.stopPropagation());
    }
    doc.addEventListener('pointerdown', onPointer, true);
    doc.addEventListener('click', onPointer, true);
    doc.addEventListener('focusin', onFocus);
    doc.addEventListener('input', onInput);
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('scroll', schedulePosition, true);
    view.addEventListener('resize', schedulePosition);
    if (view.visualViewport) {
      view.visualViewport.addEventListener('resize', schedulePosition);
      view.visualViewport.addEventListener('scroll', schedulePosition);
    }

    function destroy() {
      if (destroyed) return;
      close();
      destroyed = true;
      doc.removeEventListener('pointerdown', onPointer, true);
      doc.removeEventListener('click', onPointer, true);
      doc.removeEventListener('focusin', onFocus);
      doc.removeEventListener('input', onInput);
      doc.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('scroll', schedulePosition, true);
      view.removeEventListener('resize', schedulePosition);
      if (view.visualViewport) {
        view.visualViewport.removeEventListener('resize', schedulePosition);
        view.visualViewport.removeEventListener('scroll', schedulePosition);
      }
    }

    return { close, destroy };
  }

  return { bind, rangeFor };
});
