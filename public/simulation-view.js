'use strict';

// Pointer interaction shared by the tank and heat exchanger diagrams.
(function (root) {
  class Camera {
    constructor() {
      this.geometry = null;
      this.scale = 1;
      this.center = { x: 0, y: 0 };
      this.autoFit = true;
    }
    update(geometry) {
      if (!['width', 'height', 'viewportWidth', 'viewportHeight']
        .every(key => Number.isFinite(geometry[key]) && geometry[key] > 0)) return false;
      this.geometry = { ...geometry };
      if (this.autoFit) this.fit();
      else {
        this.scale = Math.min(1.8, Math.max(this.fitScale(), this.scale));
        this.restrict();
      }
      return true;
    }
    padding() {
      return Math.min(12, this.geometry.viewportWidth / 4, this.geometry.viewportHeight / 4);
    }
    fitScale() {
      const g = this.geometry;
      const padding = this.padding();
      return Math.min(1, (g.viewportWidth - padding * 2) / g.width,
        (g.viewportHeight - padding * 2) / g.height);
    }
    fit() {
      this.autoFit = true;
      if (!this.geometry) return;
      this.scale = this.fitScale();
      this.center = { x: this.geometry.width / 2, y: this.geometry.height / 2 };
    }
    setScale(value) {
      if (!this.geometry || !Number.isFinite(value)) return;
      const scale = Math.min(1.8, Math.max(this.fitScale(), value));
      if (Math.abs(scale - this.scale) < 1e-9) return;
      this.autoFit = false;
      this.scale = scale;
      this.restrict();
    }
    panTo({ x, y }) {
      if (!this.geometry || !Number.isFinite(x) || !Number.isFinite(y)) return;
      const before = this.frame();
      this.center = { x: (this.geometry.viewportWidth / 2 - x) / this.scale,
        y: (this.geometry.viewportHeight / 2 - y) / this.scale };
      this.restrict();
      const after = this.frame();
      if (Math.abs(before.x - after.x) > 1e-9 || Math.abs(before.y - after.y) > 1e-9) this.autoFit = false;
    }
    restrict() {
      const g = this.geometry;
      const padding = this.padding();
      for (const [axis, size, viewport] of [['x', g.width, g.viewportWidth], ['y', g.height, g.viewportHeight]]) {
        if (size * this.scale <= viewport - padding * 2) this.center[axis] = size / 2;
        else {
          const position = viewport / 2 - this.center[axis] * this.scale;
          const limited = Math.min(padding, Math.max(viewport - padding - size * this.scale, position));
          this.center[axis] = (viewport / 2 - limited) / this.scale;
        }
      }
    }
    frame() {
      const g = this.geometry;
      return { scale: this.scale, x: g.viewportWidth / 2 - this.center.x * this.scale,
        y: g.viewportHeight / 2 - this.center.y * this.scale,
        width: g.width * this.scale, height: g.height * this.scale };
    }
  }

  class ViewStore {
    constructor() { this.cameras = new Map(); }
    camera(model, expanded = false) {
      const key = `${model}:${expanded ? 'expanded' : 'normal'}`;
      if (!this.cameras.has(key)) this.cameras.set(key, new Camera());
      return this.cameras.get(key);
    }
  }

  function bindPan(viewport, { getPan, onPan, onTap, onPanStart, threshold = 6 }) {
    const host = viewport.ownerDocument?.defaultView || viewport;
    let drag = null;
    viewport.dataset && (viewport.dataset.simulationGestures = 'true');
    function emit(name, detail) {
      if (host.CustomEvent && viewport.dispatchEvent) {
        viewport.dispatchEvent(new host.CustomEvent(name, { bubbles:true, detail }));
      }
    }
    function cancel() {
      if (!drag) return;
      const pointerId = drag.pointerId;
      drag = null;
      viewport.classList.remove('panning');
      try { viewport.releasePointerCapture(pointerId); } catch {}
    }
    function finish(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const tap = drag;
      const distance = Math.hypot(event.clientX - tap.startX, event.clientY - tap.startY);
      const rect = viewport.getBoundingClientRect?.();
      const inside = !rect || (event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top && event.clientY <= rect.bottom);
      cancel();
      if (event.type === 'pointerup' && !tap.moving && distance < threshold && inside) {
        onTap?.(tap.target);
        emit('simulation:activate', { target:tap.target, clientX:event.clientX, clientY:event.clientY });
      }
    }
    viewport.addEventListener('pointerdown', (event) => {
      if (drag || event.button !== 0 || event.isPrimary === false) return;
      if (event.target.closest?.('button, input, select, textarea, a')) return;
      const origin = getPan();
      drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
        originX: origin.x, originY: origin.y, target:event.target, moving:false };
      try { viewport.setPointerCapture(event.pointerId); } catch {}
      event.preventDefault();
    });
    host.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (event.buttons === 0) { cancel(); return; }
      if (!drag.moving) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < threshold) return;
        drag.moving = true;
        viewport.classList.add('panning');
        onPanStart?.();
        emit('simulation:panstart', {});
      }
      onPan({ x: drag.originX + event.clientX - drag.startX,
        y: drag.originY + event.clientY - drag.startY });
      event.preventDefault();
    });
    host.addEventListener('pointerup', finish);
    host.addEventListener('pointercancel', finish);
    viewport.addEventListener('lostpointercapture', finish);
    host.addEventListener('blur', cancel);
    return { cancel };
  }
  const api = { bindPan, Camera, ViewStore };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SimulationView = api;
})(typeof window === 'object' ? window : globalThis);
