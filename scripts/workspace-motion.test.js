'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../public/workspace-motion');

function fixture() {
  const listeners = new Map();
  let changed;
  const preference = {
    matches:false,
    addEventListener(name, callback) { changed = callback; },
    removeEventListener() { changed = null; },
  };
  const doc = {
    hidden:false, documentElement:{ dataset:{} },
    defaultView:{ matchMedia:() => preference },
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const animations = [];
  const target = () => ({
    isConnected:true,
    animate(frames, options) {
      let resolve, reject;
      const animation = { frames, options, cancelled:false,
        finished:new Promise((yes, no) => { resolve = yes; reject = no; }),
        cancel() { this.cancelled = true; reject(new Error('cancelled')); },
        finish() { resolve(); },
      };
      animations.push(animation);
      return animation;
    },
  });
  return { doc, preference, animations, target, motion:create(doc),
    visibility(hidden) { doc.hidden = hidden; listeners.get('visibilitychange')(); },
    reduce(matches) { preference.matches = matches; changed(); },
    listeners,
  };
}

test('rapid switching cancels the old form animation across different targets', () => {
  const f = fixture();
  f.motion.selection('a', 'b', f.target());
  f.motion.selection('b', 'c', f.target());
  assert.equal(f.animations[0].cancelled, true);
  assert.equal(f.animations[1].cancelled, false);
  assert.equal(f.animations[1].options.duration, 160);
  f.motion.destroy();
});

test('a late cancellation or completion cannot lose the current animation', async () => {
  const f = fixture();
  f.motion.selection('a', 'b', f.target());
  f.motion.selection('b', 'c', f.target());
  await Promise.resolve(); // The old finished rejection arrives late.
  f.animations[0].finish();
  await Promise.resolve();
  f.motion.cancel('selection');
  assert.equal(f.animations[1].cancelled, true);
});

test('selecting the same loop does not replay or cancel its ongoing reveal', () => {
  const f = fixture();
  const form = f.target();
  f.motion.selection('a', 'b', form);
  f.motion.selection('b', 'b', form);
  assert.equal(f.animations.length, 1);
  assert.equal(f.animations[0].cancelled, false);
  f.motion.destroy();
});

test('closing a slider cancels immediately and reopening creates a fresh short reveal', () => {
  const f = fixture();
  const panel = f.target();
  f.motion.slider(panel);
  f.motion.cancel('slider');
  f.motion.slider(panel);
  assert.equal(f.animations[0].cancelled, true);
  assert.equal(f.animations[1].options.duration, 120);
  assert.equal(f.animations[1].options.fill, undefined);
  f.motion.destroy();
});

test('hidden documents stop all motion and never replay on becoming visible', () => {
  const f = fixture();
  f.motion.selection('a', 'b', f.target());
  f.motion.slider(f.target());
  f.visibility(true);
  assert.ok(f.animations.every(animation => animation.cancelled));
  f.motion.slider(f.target());
  f.visibility(false);
  assert.equal(f.animations.length, 2);
  assert.equal(f.doc.documentElement.dataset.motionPaused, 'false');
  f.motion.destroy();
});

test('changing reduced motion preference cancels movement and preserves static state', () => {
  const f = fixture();
  f.motion.slider(f.target());
  f.reduce(true);
  f.motion.selection('a', 'b', f.target());
  f.motion.slider(f.target());
  assert.equal(f.animations.length, 1);
  assert.equal(f.animations[0].cancelled, true);
  assert.equal(f.doc.documentElement.dataset.motionPaused, 'true');
  f.motion.destroy();
});

test('missing WAAPI and disconnected forms keep the default visible state', () => {
  const f = fixture();
  const detached = f.target();
  detached.isConnected = false;
  f.motion.slider(detached);
  f.motion.selection('a', 'b', { isConnected:true });
  assert.equal(f.animations.length, 0);
  f.motion.destroy();
});

test('destroy removes subscriptions and prevents later motion', () => {
  const f = fixture();
  f.motion.slider(f.target());
  f.motion.destroy();
  f.motion.slider(f.target());
  assert.equal(f.animations[0].cancelled, true);
  assert.equal(f.animations.length, 1);
  assert.equal(f.listeners.size, 0);
});

test('a newer edit cancels confirmation and a hidden form does not flash on return', () => {
  const f = fixture();
  const message = f.target();
  f.motion.confirm(message);
  assert.equal(f.animations[0].options.duration, 180);
  f.motion.cancel(message);
  message.getClientRects = () => [];
  f.motion.confirm(message);
  assert.equal(f.animations[0].cancelled, true);
  assert.equal(f.animations.length, 1);
  f.motion.destroy();
});
