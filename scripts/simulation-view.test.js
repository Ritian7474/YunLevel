'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bindPan, Camera, ViewStore } = require('../public/simulation-view');

function surface() {
  const events = new Map();
  const classes = new Set();
  const node = {
    classList: { add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name) },
    addEventListener(name, fn) {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(fn);
    },
    fire(name, details = {}) {
      const event = { type:name, pointerId: 1, clientX: 100, clientY: 80, button: 0,
        buttons: 1, isPrimary: true, target: { closest: () => null },
        preventDefault() {}, ...details };
      for (const fn of events.get(name) || []) fn(event);
    },
    setPointerCapture(id) { node.captured = id; },
    releasePointerCapture() { node.captured = null; },
  };
  return node;
}
function fixture() {
  const viewport = surface();
  const host = surface();
  viewport.ownerDocument = { defaultView: host };
  let pan = { x: 20, y: -10 };
  const interaction = bindPan(viewport, { getPan: () => pan, onPan: next => { pan = next; } });
  return { viewport, host, interaction, pan: () => pan };
}
test('normal view pans by pointer displacement, including moves outside the viewport', () => {
  const f = fixture(); // There is intentionally no fullscreen class.
  f.viewport.fire('pointerdown');
  f.host.fire('pointermove', { clientX: 340, clientY: 120 });
  assert.deepEqual(f.pan(), { x: 260, y: 30 });
  assert.equal(f.viewport.captured, 1);
  f.host.fire('pointerup');
  assert.equal(f.viewport.captured, null);
  assert.equal(f.viewport.classList.contains('panning'), false);
});
test('right clicks, secondary touches and interactive controls cannot start panning', () => {
  for (const details of [{ button: 2 }, { isPrimary: false }, { target: { closest: () => ({}) } }]) {
    const f = fixture();
    f.viewport.fire('pointerdown', details);
    f.host.fire('pointermove', { clientX: 340 });
    assert.deepEqual(f.pan(), { x: 20, y: -10 });
  }
});
test('another pointer cannot interrupt or move an active drag', () => {
  const f = fixture();
  f.viewport.fire('pointerdown');
  f.viewport.fire('pointerdown', { pointerId: 2, clientX: 400 });
  f.host.fire('pointermove', { pointerId: 2, clientX: 500 });
  f.host.fire('pointerup', { pointerId: 2 });
  assert.deepEqual(f.pan(), { x: 20, y: -10 });
  f.host.fire('pointermove', { clientX: 150 });
  assert.equal(f.pan().x, 70);
});
test('cancel, lost capture, released buttons, blur and view changes stop dragging', () => {
  for (const reason of ['pointercancel', 'lostpointercapture', 'buttons', 'blur', 'view']) {
    const f = fixture();
    f.viewport.fire('pointerdown');
    if (reason === 'lostpointercapture') f.viewport.fire(reason);
    else if (reason === 'buttons') f.host.fire('pointermove', { buttons: 0 });
    else if (reason === 'view') f.interaction.cancel();
    else f.host.fire(reason);
    f.host.fire('pointermove', { clientX: 400 });
    assert.deepEqual(f.pan(), { x: 20, y: -10 });
    assert.equal(f.viewport.classList.contains('panning'), false);
  }
});
test('dragging still works when pointer capture is unavailable', () => {
  const f = fixture();
  f.viewport.setPointerCapture = () => { throw new Error('no capture'); };
  f.viewport.fire('pointerdown');
  f.host.fire('pointermove', { clientX: 150 });
  f.host.fire('pointerup');
  assert.equal(f.pan().x, 70);
  assert.equal(f.viewport.classList.contains('panning'), false);
});

test('a device tap activates once and small pointer jitter never pans', () => {
  const viewport = surface(), host = surface(), taps = [], pans = [];
  viewport.ownerDocument = { defaultView:host };
  const target = { closest:() => null };
  bindPan(viewport, { getPan:() => ({ x:0, y:0 }), onPan:pan => pans.push(pan), onTap:node => taps.push(node) });
  viewport.fire('pointerdown', { target });
  host.fire('pointermove', { clientX:104, clientY:82 });
  host.fire('pointerup', { clientX:104, clientY:82 });
  host.fire('pointerup');
  assert.deepEqual(taps, [target]);
  assert.deepEqual(pans, []);
});
test('crossing the six-pixel threshold starts pan once and never activates on release', () => {
  const viewport = surface(), host = surface(); let starts = 0, taps = 0, pan;
  viewport.ownerDocument = { defaultView:host };
  bindPan(viewport, { getPan:() => ({ x:20, y:30 }), onPan:value => { pan = value; },
    onTap:() => taps++, onPanStart:() => starts++ });
  viewport.fire('pointerdown');
  assert.equal(viewport.classList.contains('panning'), false);
  host.fire('pointermove', { clientX:106 });
  host.fire('pointermove', { clientX:120 });
  host.fire('pointerup');
  assert.deepEqual(pan, { x:40, y:30 });
  assert.equal(starts, 1); assert.equal(taps, 0);
});
test('cancellation, leaving the viewport and a far release cannot activate a device', () => {
  for (const reason of ['pointercancel', 'lostpointercapture', 'blur', 'outside', 'far']) {
    const viewport = surface(), host = surface(); let taps = 0;
    viewport.ownerDocument = { defaultView:host };
    viewport.getBoundingClientRect = () => ({ left:99, right:200, top:79, bottom:180 });
    bindPan(viewport, { getPan:() => ({ x:0, y:0 }), onPan:() => {}, onTap:() => taps++ });
    viewport.fire('pointerdown');
    if (reason === 'outside') host.fire('pointerup', { clientX:98 });
    else if (reason === 'far') host.fire('pointerup', { clientX:150 });
    else if (reason === 'lostpointercapture') viewport.fire(reason);
    else host.fire(reason);
    host.fire('pointerup');
    assert.equal(taps, 0, reason);
  }
});
test('tap notifications retain release coordinates for overlapping device targets', () => {
  const viewport = surface(), host = surface(), events = [];
  viewport.ownerDocument = { defaultView:host };
  host.CustomEvent = class { constructor(type, args) { this.type = type; Object.assign(this,args); } };
  viewport.dispatchEvent = event => events.push(event);
  bindPan(viewport, { getPan:() => ({ x:0,y:0 }),onPan:() => {} });
  viewport.fire('pointerdown'); host.fire('pointerup', { clientX:103,clientY:81 });
  assert.equal(events[0].type, 'simulation:activate');
  assert.equal(events[0].bubbles, true);
  assert.equal(events[0].detail.clientX, 103); assert.equal(events[0].detail.clientY, 81);
});

const geometry = { width: 1100, height: 470, viewportWidth: 720, viewportHeight: 478 };
function fittedCamera(overrides = {}) {
  const camera = new Camera();
  camera.update({ ...geometry, ...overrides });
  return camera;
}
function near(got, expected) { assert.ok(Math.abs(got - expected) < 1e-7, `${got} != ${expected}`); }
test('the full diagram fits and stays centered in desktop, narrow and short viewports', () => {
  for (const [width, height] of [[720, 478], [320, 478], [1500, 260], [2200, 1200]]) {
    const camera = fittedCamera({ viewportWidth: width, viewportHeight: height });
    const frame = camera.frame();
    assert.ok(frame.width <= width - camera.padding() * 2 + 1e-7);
    assert.ok(frame.height <= height - camera.padding() * 2 + 1e-7);
    near(frame.x + frame.width / 2, width / 2);
    near(frame.y + frame.height / 2, height / 2);
  }
});
test('zoom preserves the world point at the center and stops at fit and 180%', () => {
  const camera = fittedCamera();
  const center = { ...camera.center };
  camera.setScale(1.2);
  near(camera.center.x, center.x);
  near(camera.center.y, center.y);
  camera.setScale(100);
  assert.equal(camera.scale, 1.8);
  camera.setScale(-100);
  near(camera.scale, camera.fitScale());
});
test('large drags cannot move the diagram beyond either edge or create blank viewports', () => {
  const camera = fittedCamera();
  camera.setScale(1.8);
  for (const position of [{ x: -1e6, y: -1e6 }, { x: 1e6, y: 1e6 }]) {
    camera.panTo(position);
    const frame = camera.frame();
    assert.ok(frame.x <= camera.padding() + 1e-7);
    assert.ok(frame.x + frame.width >= geometry.viewportWidth - camera.padding() - 1e-7);
    assert.ok(frame.y <= camera.padding() + 1e-7);
    assert.ok(frame.y + frame.height >= geometry.viewportHeight - camera.padding() - 1e-7);
  }
});
test('fit recovers a zoomed and panned diagram and follows later panel resizing', () => {
  const camera = fittedCamera();
  camera.setScale(1.6);
  camera.panTo({ x: -200, y: -100 });
  camera.fit();
  assert.equal(camera.autoFit, true);
  camera.update({ ...geometry, viewportWidth: 450 });
  near(camera.scale, (450 - 24) / 1100);
  near(camera.center.x, 550);
  near(camera.center.y, 235);
});
test('manual zoom and the world focus survive resize when within the new bounds', () => {
  const camera = fittedCamera();
  camera.setScale(1.6);
  camera.panTo({ x: -400, y: -140 });
  const center = { ...camera.center };
  camera.update({ ...geometry, viewportWidth: 750, viewportHeight: 500 });
  assert.equal(camera.scale, 1.6);
  near(camera.center.x, center.x);
  near(camera.center.y, center.y);
});
test('hidden panels and non-finite input cannot erase a valid camera or poison transforms', () => {
  const camera = fittedCamera();
  const before = camera.frame();
  assert.equal(camera.update({ ...geometry, viewportWidth: 0 }), false);
  assert.equal(camera.update({ ...geometry, height: NaN }), false);
  camera.setScale(Infinity);
  camera.panTo({ x: NaN, y: 0 });
  assert.deepEqual(camera.frame(), before);
});
test('boundary and centering invariants hold across fit, zoom and extreme pan combinations', () => {
  for (const width of [180, 320, 720, 1500]) {
    for (const height of [120, 300, 478, 900]) {
      const camera = fittedCamera({ viewportWidth: width, viewportHeight: height });
      for (const zoom of [0.2, 0.8, 1.2, 1.8]) {
        camera.setScale(zoom);
        for (const offset of [-1e6, 0, 1e6]) {
          camera.panTo({ x: offset, y: offset });
          const frame = camera.frame();
          for (const [position, size, viewport] of [[frame.x, frame.width, width], [frame.y, frame.height, height]]) {
            assert.ok(Number.isFinite(position));
            if (size <= viewport - camera.padding() * 2) near(position, (viewport - size) / 2);
            else {
              assert.ok(position <= camera.padding() + 1e-7);
              assert.ok(position + size >= viewport - camera.padding() - 1e-7);
            }
          }
        }
      }
    }
  }
});

test('fullscreen has its own fitted camera and cannot reset a normal view', () => {
  const store = new ViewStore();
  const normal = store.camera('tank');
  normal.update(geometry);
  normal.setScale(1.4);
  normal.panTo({ x: -400, y: -70 });
  const before = normal.frame();
  const expanded = store.camera('tank', true);
  expanded.update({ ...geometry, viewportWidth: 1472, viewportHeight: 390 });
  assert.equal(expanded.autoFit, true);
  expanded.setScale(1.7);
  expanded.panTo({ x: -200, y: -200 });
  assert.equal(store.camera('tank'), normal);
  normal.update(geometry);
  assert.deepEqual(normal.frame(), before);
});
test('both models retain independent normal and fullscreen positions', () => {
  const store = new ViewStore();
  const frames = new Map();
  for (const model of ['tank', 'hx']) {
    for (const expanded of [false, true]) {
      const camera = store.camera(model, expanded);
      camera.update(geometry);
      camera.setScale(model === 'tank' ? 1.1 : 1.6);
      camera.panTo({ x: expanded ? -180 : -140, y: -50 });
      frames.set(`${model}:${expanded}`, camera.frame());
    }
  }
  store.camera('hx', true).fit();
  for (const [model, expanded] of [['tank', false], ['tank', true], ['hx', false]]) {
    assert.deepEqual(store.camera(model, expanded).frame(), frames.get(`${model}:${expanded}`));
  }
});
test('hiding and returning to the control tab keeps a manually adjusted view', () => {
  const store = new ViewStore();
  const camera = store.camera('hx');
  camera.update(geometry);
  camera.setScale(1.6);
  camera.panTo({ x: -300, y: -150 });
  const before = camera.frame();
  assert.equal(camera.update({ ...geometry, viewportWidth: 0, viewportHeight: 0 }), false);
  store.camera('hx', false).update(geometry);
  assert.deepEqual(camera.frame(), before);
});
