(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProcessDevices = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const catalogs = {
    tank:[
      { id:'P101', name:'进水泵', key:'pump', unit:'%', manual:'pumpInput', badge:'pumpNode', box:[123,144,44,44] },
      { id:'FV101', name:'给水总阀', key:'fv101', unit:'%', mv:0, manual:'fv101Input', badge:'fv101Node', box:[193,144,44,44] },
      { id:'T1', name:'1#罐 · LI101', key:'h1', unit:'%', pv:0, sp:'sp1', box:[270,70,130,190] },
      { id:'FV102', name:'级间阀 1', key:'fv102', unit:'%', mv:1, manual:'fv102Input', badge:'fv102Node', box:[453,178,44,44] },
      { id:'T2', name:'2#罐 · LI102', key:'h2', unit:'%', pv:1, sp:'sp2', box:[530,70,130,190] },
      { id:'FV103', name:'级间阀 2', key:'fv103', unit:'%', mv:2, manual:'fv103Input', badge:'fv103Node', box:[713,178,44,44] },
      { id:'T3', name:'3#罐 · LI103', key:'h3', unit:'%', pv:2, sp:'sp3', box:[790,70,130,190] },
      { id:'FV104', name:'出口阀', key:'fv104', unit:'%', mv:3, manual:'fv104Input', badge:'fv104Node', box:[973,178,44,44] },
    ],
    hx:[
      { id:'TI1103', name:'入口蒸汽温度', key:'ti1103', unit:'℃', manual:'inletTempInput', badge:'hxInstTi1103', box:[96,88,44,44] },
      { id:'E1102', name:'换热器', key:'ti1104', unit:'℃', pv:0, sp:'sp', box:[250,40,320,170] },
      { id:'TI1104', name:'出口温度', key:'ti1104', unit:'℃', pv:0, sp:'sp', badge:'hxInstTi1104', box:[626,88,44,44] },
      { id:'FI1105', name:'蒸汽流量', key:'fi1105', unit:'kg/s', pv:1, sp:'spf', badge:'hxInstFi1105', box:[720,88,44,44] },
      { id:'FV1105', name:'蒸汽出口阀', key:'fv1105', unit:'%', mv:2, manual:'fv1105Input', badge:'hxFV1105Node', box:[830,80,44,52] },
      { id:'FV1102', name:'冷却水阀', key:'fv1102', unit:'%', mv:0, manual:'fv1102Input', badge:'hxFV1102Node', box:[100,274,44,48] },
      { id:'FI1102', name:'冷却水流量', key:'mw', unit:'kg/s', relatedMv:0, badge:'hxInstFi1102', box:[216,278,44,44] },
    ],
  };
  function devices(model) { return catalogs[model] || []; }
  function related(device, entries) {
    return entries.filter(entry => {
      const value = entry.value;
      if (device.mv !== undefined || device.relatedMv !== undefined) return Number(value.mv) === Number(device.mv ?? device.relatedMv);
      if (device.pv === undefined) return false;
      return entry.kind === 'loop' ? Number(value.pv) === device.pv
        : Number(value.outer) === device.pv || Number(value.inner) === device.pv;
    });
  }
  function reading(device, state) {
    const raw = state?.[device.key];
    const valid = raw !== null && raw !== undefined && String(raw).trim() !== '' && Number.isFinite(Number(raw));
    return valid ? `${Number(raw).toFixed(device.unit === 'kg/s' ? 2 : 1)} ${device.unit}` : '—';
  }
  function place(anchor, size, viewport) {
    const pad = 12;
    const maxX = Math.max(pad, viewport.width - size.width - pad);
    const right = anchor.right + pad;
    const left = right + size.width <= viewport.width - pad ? right : anchor.left - size.width - pad;
    return { left:Math.max(pad, Math.min(maxX, left)),
      top:viewport.top + Math.max(pad, Math.min(viewport.height - size.height - pad, anchor.top - viewport.top)) };
  }
  function hitBox(device, scale) {
    const [x,y,w,h] = device.box;
    const minimum = 44 / (Number.isFinite(scale) && scale > 0 ? scale : 1);
    const width = Math.max(w, minimum), height = Math.max(h, minimum);
    return { x:x + (w - width) / 2,y:y + (h - height) / 2,width,height };
  }
  function nearestHit(point, candidates) {
    return candidates.filter(item => point.x >= item.rect.left && point.x <= item.rect.right && point.y >= item.rect.top && point.y <= item.rect.bottom)
      .sort((a,b) => Math.hypot(point.x - (a.rect.left + a.rect.right) / 2,point.y - (a.rect.top + a.rect.bottom) / 2)
        - Math.hypot(point.x - (b.rect.left + b.rect.right) / 2,point.y - (b.rect.top + b.rect.bottom) / 2))[0]?.node || null;
  }
  function bind(doc, options) {
    const view = doc.defaultView;
    const panel = doc.createElement('section');
    panel.id = 'processDevicePanel'; panel.className = 'process-device-panel'; panel.hidden = true;
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', 'processDeviceTitle');
    panel.innerHTML = '<header><div><h2 id="processDeviceTitle"></h2><p class="device-description"></p></div>' +
      '<button type="button" class="device-close" aria-label="关闭设备操作"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></header>' +
      '<div class="device-reading"><span>当前测量值</span><strong></strong></div><p class="device-ownership"></p><div class="device-content"></div>';
    doc.body.append(panel);
    const nodes = [];
    let active = null, gesture = null, bindings = [], contentSignature = '', tapped = null;
    function context() { return options.getContext(); }
    function close({ restoreFocus = false } = {}) {
      const previous = active;
      active = null; panel.hidden = true;
      options.motion?.cancel(panel.querySelector('.device-feedback'));
      nodes.forEach(node => node.setAttribute('aria-pressed', 'false'));
      if (restoreFocus && previous?.anchor.isConnected) {
        (nodes.find(node => node.dataset.deviceModel === previous.model && node.dataset.processDevice === previous.device.id) || previous.anchor).focus({ preventScroll:true });
      }
    }
    function updateTargets() {
      nodes.forEach(node => {
        const model = node.dataset.deviceModel;
        const device = devices(model).find(item => item.id === node.dataset.processDevice);
        const matrix = node.ownerSVGElement.getScreenCTM();
        const box = hitBox(device, Math.hypot(matrix?.a || 1,matrix?.b || 0));
        Object.entries(box).forEach(([name,value]) => { if (Number(node.getAttribute(name)) !== value) node.setAttribute(name,value); });
      });
    }
    function position() {
      if (!active) return;
      const anchor = active.anchor.getBoundingClientRect();
      const viewport = view.visualViewport;
      const width = viewport?.width || view.innerWidth, height = viewport?.height || view.innerHeight;
      const top = viewport?.offsetTop || 0;
      panel.style.maxHeight = Math.max(120, height - 24) + 'px';
      if (view.matchMedia('(width < 900px)').matches) {
        panel.style.left = (viewport?.offsetLeft || 0) + 'px';
        panel.style.top = ''; panel.style.bottom = Math.max(0, view.innerHeight - top - height) + 'px';
        return;
      }
      panel.style.bottom = '';
      const xy = place(anchor, panel.getBoundingClientRect(), { width, height, top });
      panel.style.left = xy.left + 'px'; panel.style.top = xy.top + 'px';
    }
    function refresh() {
      if (!active) return;
      const ctx = context();
      if (ctx.model !== active.model || !ctx.account || ctx.view !== 'control' || !active.anchor.getClientRects().length) { close(); return; }
      panel.querySelector('.device-reading strong').textContent = reading(active.device, ctx.state);
      const owners = related(active.device, ctx.entries || []);
      panel.querySelector('.device-ownership').textContent = ctx.account.viewOnly
        ? '观察窗口 · 仅可查看'
        : owners.length ? `关联 ${owners.length} 个回路，调节通过回路生效。` : active.device.manual ? '独立手操 · 应用后生效' : '尚未连接回路';
      renderContent(owners);
      position();
    }
    function renderContent(owners) {
      if (!options.controls) return;
      if (active.loopKey && !owners.some(item => item.key === active.loopKey)) active.loopKey = null;
      if (!active.loopKey && owners.length === 1) {
        active.loopKey = owners[0].key; options.select?.(active.loopKey);
      }
      const data = options.controls.describe(active.device, active.loopKey);
      const signature = `${active.model}:${active.device.id}:${active.loopKey}:${owners.map(item => item.key).join('|')}:${data.fields.map(item => item.key).join('|')}:${data.actions.map(item => item.id).join('|')}`;
      const content = panel.querySelector('.device-content');
      if (contentSignature !== signature) {
        contentSignature = signature; content.replaceChildren(); bindings = [];
        if (owners.length > 1) {
          const label = doc.createElement('label'); label.className = 'device-loop-choice'; label.textContent = '选择关联回路';
          const select = doc.createElement('select');
          select.append(new view.Option('请选择回路', ''));
          owners.forEach(item => select.append(new view.Option(`${item.kind === 'loop' ? '单回路' : '串级'} ${item.index + 1}`, item.key)));
          select.value = active.loopKey || '';
          select.onchange = () => { active.loopKey = select.value || null; if (active.loopKey) options.select?.(active.loopKey); refresh(); };
          label.append(select); content.append(label);
        }
        if (owners.length > 1 && !active.loopKey) {
          const hint = doc.createElement('p'); hint.className = 'device-hint'; hint.textContent = '此设备关联多个回路，选择后调节。'; content.append(hint);
          return;
        }
        const advanced = doc.createElement('details'); advanced.className = 'device-pid-details';
        const summary = doc.createElement('summary'); summary.textContent = 'PID 参数'; advanced.append(summary);
        const grids = new Map();
        data.fields.forEach(field => {
          const pid = /(?:kp|ti|td)$/i.test(field.key);
          const groupKey = `${pid}:${field.group || ''}`;
          let grid = grids.get(groupKey);
          if (!grid) {
            const group = doc.createElement('fieldset'); group.className = 'device-field-group';
            if (field.group) { const legend = doc.createElement('legend'); legend.textContent = field.group; group.append(legend); }
            grid = doc.createElement('div'); grid.className = 'device-fields'; group.append(grid);
            (pid ? advanced : content).append(group); grids.set(groupKey,grid);
          }
          const wrap = doc.createElement('div'); wrap.className = 'device-field';
          const label = doc.createElement('label'); label.textContent = field.label;
          const control = doc.createElement('input'); control.type = field.source.type;
          control.setAttribute('aria-label', [field.group,field.label].filter(Boolean).join(' '));
          control.dataset.deviceField = field.key; control.setAttribute('inputmode', 'decimal');
          control.name = `device-${field.key}`; control.autocomplete = 'off';
          if (field.source.step) control.step = field.source.step;
          label.append(control); wrap.append(label); grid.append(wrap);
          const range = doc.createElement('input'); range.type = 'range'; range.setAttribute('aria-label', field.label + '滑块');
          wrap.append(range);
          let infinity;
          if (field.policy?.allowInfinity) {
            const check = doc.createElement('label'); check.className = 'device-infinity';
            infinity = doc.createElement('input'); infinity.type = 'checkbox';
            infinity.setAttribute('aria-label', [field.group,'Ti 关闭积分'].filter(Boolean).join(' '));
            check.append(infinity, '关闭积分（inf）'); wrap.append(check);
          }
          const binding = { key:field.key,control,range,infinity,source:field.source,memory:null };
          control.oninput = () => write(binding, control.value);
          control.onblur = () => syncFields();
          range.oninput = () => write(binding, range.value);
          if (infinity) infinity.onchange = () => write(binding, infinity.checked ? 'inf' : binding.memory ?? field.policy.min);
          bindings.push(binding);
        });
        if (advanced.children.length > 1) { advanced.addEventListener('toggle', position); content.append(advanced); }
        const hint = doc.createElement('p'); hint.className = 'device-hint'; hint.textContent = data.readonly;
        content.append(hint);
        const feedback = doc.createElement('p'); feedback.className = 'device-feedback parameter-feedback';
        feedback.setAttribute('role','status'); feedback.setAttribute('aria-live','polite'); content.append(feedback);
        const actions = doc.createElement('div'); actions.className = 'device-actions';
        data.actions.forEach(action => {
          const button = doc.createElement('button'); button.type = 'button'; button.dataset.deviceAction = action.id;
          button.className = action.primary ? 'primary' : ''; button.textContent = action.label;
          button.onclick = async () => {
            if (!active || button.disabled || active.pending) return;
            const saved = active, device = saved.device, loopKey = saved.loopKey;
            saved.error = ''; saved.pending = true;
            button.setAttribute('aria-disabled','true');
            try {
              const result = await options.controls.act(device, loopKey, action.id);
              if (active === saved && result?.ok) { refresh();
                const output = panel.querySelector('.device-feedback');
                if (output?.dataset.phase === 'applied') options.motion?.confirm(output); }
            } catch (error) {
              if (active === saved) { saved.error = `${error.message}。草稿已保留。`; }
            } finally { saved.pending = false; if (active === saved) { syncFields(); position(); } }
          };
          actions.append(button);
        });
        if (data.entry) {
          const inspect = doc.createElement('button'); inspect.type = 'button'; inspect.textContent = '查看侧栏参数';
          inspect.onclick = () => { const key = active.loopKey; close(); options.inspect?.(key); }; actions.append(inspect);
        } else if (data.canBuild) {
          const build = doc.createElement('button'); build.type = 'button'; build.textContent = '去搭建回路';
          build.onclick = () => { const device = active.device; close(); options.build?.(device); }; actions.append(build);
        }
        content.append(actions);
      }
      syncFields();
    }
    function syncFields() {
      if (!active || !options.controls) return;
      const data = options.controls.describe(active.device, active.loopKey);
      bindings.forEach(binding => {
        const field = data.fields.find(item => item.key === binding.key);
        if (!field) return;
        const source = field.source; binding.source = source;
        const readonly = field.disabled || source.disabled || source.readOnly;
        binding.control.readOnly = readonly;
        binding.control.title = readonly ? '当前只读；自动模式输出请先投手动' : '';
        if (binding.control !== doc.activeElement && binding.control.value !== source.value) binding.control.value = source.value;
        if (!field.policy) { binding.range.hidden = true; return; }
        const range = view.ParameterSlider.rangeFor(field.policy, source.value, binding.memory);
        binding.memory = range.rememberedFinite;
        binding.range.min = range.min; binding.range.max = range.max; binding.range.step = range.step;
        binding.range.value = range.value; binding.range.disabled = readonly || range.infinity || range.invalid;
        binding.range.setAttribute('aria-valuetext', range.infinity ? '关闭积分' : source.value);
        if (binding.infinity) { binding.infinity.checked = range.infinity; binding.infinity.disabled = readonly; }
      });
      const pending = data.root?.getAttribute('aria-busy') === 'true';
      panel.setAttribute('aria-busy', String(pending));
      data.actions.forEach(action => {
        const button = panel.querySelector(`[data-device-action="${action.id}"]`);
        if (button) { button.disabled = action.disabled;
          button.setAttribute('aria-disabled', String(action.disabled || pending));
          button.textContent = pending && action.primary ? '应用中…' : action.label;
          if (pending && action.primary) button.dataset.submitting = '1'; else delete button.dataset.submitting; }
      });
      const sourceFeedback = data.root?.querySelector('.parameter-feedback');
      const feedback = panel.querySelector('.device-feedback');
      if (feedback && active.error) { feedback.textContent = active.error; feedback.dataset.phase = 'error'; }
      else if (feedback && sourceFeedback) { feedback.textContent = sourceFeedback.textContent; feedback.dataset.phase = sourceFeedback.dataset.phase; }
    }
    function write(binding, value) {
      if (!active) return;
      const field = options.controls.describe(active.device, active.loopKey).fields.find(item => item.key === binding.key);
      if (!field || field.disabled || field.source.disabled || field.source.readOnly) return;
      active.error = '';
      field.source.value = String(value);
      field.source.dispatchEvent(new view.Event('input', { bubbles:true }));
      binding.control.value = field.source.value; syncFields();
    }
    function open(node) {
      const ctx = context();
      const device = devices(ctx.model).find(item => item.id === node?.dataset.processDevice);
      if (!device || !ctx.account || ctx.view !== 'control') return;
      const owners = related(device, ctx.entries || []);
      const retained = owners.find(item => item.key === ctx.selectedKey);
      active = { device, anchor:node, model:ctx.model, loopKey:retained?.key || (owners.length === 1 ? owners[0].key : null) };
      if (active.loopKey) options.select?.(active.loopKey);
      contentSignature = '';
      panel.querySelector('h2').textContent = device.id;
      panel.querySelector('.device-description').textContent = device.name;
      panel.hidden = false;
      nodes.forEach(item => item.setAttribute('aria-pressed', String(item.dataset.processDevice === device.id && item.dataset.deviceModel === ctx.model)));
      refresh();
      panel.querySelector('.device-close').focus({ preventScroll:true });
    }
    for (const model of ['tank', 'hx']) {
      const svg = doc.querySelector(model === 'tank' ? '#processVisual .hx-svg' : '#hxProcessVisual .hx-svg');
      if (!svg) continue;
      svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', model === 'tank' ? '液位设备操作' : '换热器设备操作');
      for (const device of devices(model)) {
        const hit = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
        const [x,y,width,height] = device.box;
        Object.entries({ x,y,width,height,rx:8,role:'button',tabindex:0,'aria-label':`${device.id} ${device.name}，查看与操作`,
          'aria-pressed':'false','aria-haspopup':'dialog' }).forEach(([key,value]) => hit.setAttribute(key, value));
        hit.dataset.processDevice = device.id; hit.dataset.deviceModel = model; hit.classList.add('device-hit');
        svg.append(hit); nodes.push(hit);
        const badge = device.badge && doc.getElementById(device.badge);
        if (badge) { badge.dataset.processDevice = device.id; badge.dataset.deviceModel = model; badge.classList.add('device-badge'); }
      }
    }
    const viewport = doc.querySelector('.process-viewport');
    viewport?.addEventListener('simulation:activate', event => {
      let node = event.detail.target.closest?.('[data-process-device]');
      if (node?.classList.contains('device-hit') && Number.isFinite(event.detail.clientX)) {
        node = nearestHit({ x:event.detail.clientX,y:event.detail.clientY }, nodes.filter(item => item.dataset.deviceModel === context().model)
          .map(item => ({ node:item,rect:item.getBoundingClientRect() }))) || node;
      } else node = tapped || node;
      tapped = null; open(node);
    });
    viewport?.addEventListener('simulation:panstart', () => close());
    // The standalone UI branch also works with the incumbent fullscreen pan handler.
    viewport?.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.isPrimary === false || gesture) return;
      let node = event.target.closest?.('[data-process-device]');
      if (node?.classList.contains('device-hit')) {
        const candidate = nearestHit({ x:event.clientX,y:event.clientY }, nodes.filter(item => item.dataset.deviceModel === context().model)
          .map(item => ({ node:item,rect:item.getBoundingClientRect() })));
        if (candidate) node = candidate;
      }
      tapped = node;
      if (viewport.dataset.simulationGestures === 'true') return;
      if (!node) return;
      event.stopPropagation(); event.preventDefault();
      gesture = { id:event.pointerId, x:event.clientX, y:event.clientY, node, moved:false, origin:options.getPan?.() };
      try { viewport.setPointerCapture(event.pointerId); } catch {}
    }, true);
    view.addEventListener('pointermove', event => {
      if (!gesture || gesture.id !== event.pointerId) return;
      if (!event.buttons) { gesture = null; return; }
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >= 6) {
        if (!gesture.moved) close();
        gesture.moved = true;
        if (gesture.origin) options.panTo?.({ x:gesture.origin.x + event.clientX - gesture.x, y:gesture.origin.y + event.clientY - gesture.y });
      }
    });
    view.addEventListener('pointerup', event => {
      if (!gesture || gesture.id !== event.pointerId) return;
      const saved = gesture; gesture = null;
      try { viewport.releasePointerCapture(event.pointerId); } catch {}
      const rect = viewport.getBoundingClientRect();
      if (!saved.moved && Math.hypot(event.clientX - saved.x,event.clientY - saved.y) < 6 &&
        event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) open(saved.node);
    });
    const cancel = () => { tapped = null; if (gesture) { try { viewport.releasePointerCapture(gesture.id); } catch {} gesture = null; } };
    view.addEventListener('pointercancel', cancel); viewport?.addEventListener('lostpointercapture', cancel);
    view.addEventListener('blur', cancel);
    doc.addEventListener('keydown', event => {
      const node = event.target.closest?.('[data-process-device]');
      if (node && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open(node); }
      if (event.key === 'Escape' && active && !event.defaultPrevented) { event.preventDefault(); event.stopImmediatePropagation(); close({ restoreFocus:true }); }
      if (event.key === 'Tab' && active && !event.shiftKey && event.target === Array.from(panel.querySelectorAll('input,select,button')).filter(node => !node.disabled && node.getClientRects().length).at(-1)) {
        const all = Array.from(doc.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')).filter(node => !panel.contains(node) && node.tabIndex >= 0 && !node.disabled && node.getClientRects().length);
        const anchor = nodes.find(node => node.dataset.deviceModel === active.model && node.dataset.processDevice === active.device.id);
        const next = all[all.indexOf(anchor) + 1];
        if (next) { event.preventDefault(); close(); next.focus(); }
      }
    }, true);
    doc.addEventListener('pointerdown', event => {
      if (active && !panel.contains(event.target) && !event.target.closest?.('[data-process-device]')) close();
    }, true);
    panel.querySelector('.device-close').onclick = () => close({ restoreFocus:true });
    view.addEventListener('resize', () => { updateTargets(); position(); }); view.addEventListener('scroll', position, true);
    view.visualViewport?.addEventListener('resize', position); view.visualViewport?.addEventListener('scroll', position);
    const observer = new view.MutationObserver(() => { updateTargets(); if (active) refresh(); });
    if (viewport) observer.observe(viewport, { subtree:true, attributes:true, attributeFilter:['style','class'] });
    updateTargets();
    doc.addEventListener('input', event => { if (!panel.contains(event.target)) syncFields(); });
    const formObserver = new view.MutationObserver(() => { if (active) { syncFields(); position(); } });
    for (const id of ['loopCards','manualControls']) {
      const root = doc.getElementById(id);
      if (root) formObserver.observe(root, { subtree:true,attributes:true,childList:true,
        attributeFilter:['aria-busy','data-dirty','disabled','readonly','data-phase'] });
    }
    return { refresh, close, position, selectLoop(key) {
      if (active && related(active.device, context().entries || []).some(item => item.key === key)) { active.loopKey = key; refresh(); }
      else close();
    } };
  }
  return { devices, related, reading, place, hitBox, nearestHit, bind };
});
