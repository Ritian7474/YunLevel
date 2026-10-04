'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyDraft } = require('../public/parameter-feedback');
const { setReadonlyActions } = require('../public/parameter-feedback');
const { bind } = require('../public/parameter-feedback');
const input = value => ({ value, dataset:{ dirty:'1' } });

test('a late successful reply preserves edits made while the request is in flight', async () => {
  const field = input('0.50');
  let resolve;
  const pending = applyDraft([field], () => new Promise(done => { resolve = done; }));
  field.value = '0.66';
  delete field.dataset.dirty; // Existing callbacks may clear dirty markers.
  resolve();
  await pending;
  assert.equal(field.value, '0.66');
  assert.equal(field.dataset.dirty, '1');
});
test('failed or partially applied requests preserve the submitted draft', async () => {
  const field = input('65');
  await assert.rejects(applyDraft([field], async () => {
    delete field.dataset.dirty;
    throw new Error('gateway failure');
  }), /gateway failure/);
  assert.equal(field.value, '65');
  assert.equal(field.dataset.dirty, '1');
});
test('successful numeric normalization clears an unchanged draft', async () => {
  const field = input('0.50');
  await applyDraft([field], async () => { field.value = '0.500'; });
  assert.equal(field.dataset.dirty, undefined);
});
test('clearing a submitted field while waiting remains an unapplied draft', async () => {
  const field = input('60');
  await applyDraft([field], async () => { field.value = ''; });
  assert.equal(field.dataset.dirty, '1');
});
test('observation disables every loop action and control promotion restores prior constraints', () => {
  const actions = [{ disabled:false, dataset:{} }, { disabled:true, dataset:{} }];
  setReadonlyActions(actions, true);
  setReadonlyActions(actions, true);
  assert.ok(actions.every(action => action.disabled));
  setReadonlyActions(actions, false);
  assert.deepEqual(actions.map(action => action.disabled), [false, true]);
  assert.ok(actions.every(action => action.dataset.feedbackDisabled === undefined));
});

function feedbackFixture() {
  const field = { ...input('0.50'), tagName:'INPUT', disabled:false, readOnly:false };
  const button = { textContent:'应用参数', disabled:false, dataset:{},
    setAttribute() {}, removeAttribute() {}, closest:() => root };
  let output;
  const attrs = {};
  const events = {};
  const confirmations = [];
  const cancellations = [];
  const root = {
    isConnected:true,
    querySelectorAll:selector => selector === 'input' ? [field] : [button],
    querySelector:selector => selector === '.parameter-feedback' ? output : button,
    insertBefore:element => { output = element; },
    setAttribute(name, value) { attrs[name] = value; },
  };
  field.closest = () => root;
  const doc = {
    defaultView:{ MutationObserver:class { observe() {} disconnect() {} } },
    addEventListener(name, callback) { events[name] = callback; },
    removeEventListener(name) { delete events[name]; },
    querySelectorAll:selector => selector === '.parameter-feedback' ? [output] : [root],
    getElementById:() => root,
    createElement:() => ({ dataset:{}, textContent:'', setAttribute() {} }),
  };
  const feedback = bind(doc, { motion:{ confirm:element => confirmations.push(element), cancel:element => cancellations.push(element) } });
  return { field, button, root, attrs, confirmations, cancellations, feedback,
    output:() => output, edit(value) { field.value = value; events.input({ target:field }); } };
}

test('pending feedback prevents duplicate requests; successful feedback plays only once', async () => {
  const f = feedbackFixture();
  let finish, requests = 0;
  const pending = f.feedback.submit(f.button, () => { requests++; return new Promise(done => { finish = done; }); });
  assert.equal(f.output().dataset.phase, 'pending');
  assert.equal(f.attrs['aria-busy'], 'true');
  await f.feedback.submit(f.button, () => { requests++; });
  assert.equal(requests, 1);
  finish(); await pending;
  assert.equal(f.output().dataset.phase, 'applied');
  assert.equal(f.button.textContent, '应用参数');
  assert.equal(f.button.dataset.submitting, undefined);
  f.feedback.refresh(); f.feedback.refresh(); // Realtime refresh is static.
  assert.equal(f.confirmations.length, 1);
  f.feedback.destroy();
});

test('late success with a newer draft leaves draft feedback without success motion', async () => {
  const f = feedbackFixture();
  let finish;
  const pending = f.feedback.submit(f.button, () => new Promise(done => { finish = done; }));
  f.edit('0.66'); finish(); await pending;
  assert.equal(f.field.dataset.dirty, '1');
  assert.equal(f.output().dataset.phase, 'draft');
  assert.equal(f.confirmations.length, 0);
  f.feedback.destroy();
});

test('failed requests retain a stable error and draft; readonly promotion suppresses confirmation', async () => {
  const f = feedbackFixture();
  await f.feedback.submit(f.button, async () => { throw new Error('gateway failure'); });
  f.feedback.refresh();
  assert.equal(f.output().dataset.phase, 'error');
  assert.match(f.output().textContent, /草稿已保留/);
  assert.equal(f.field.dataset.dirty, '1');
  assert.equal(f.confirmations.length, 0);
  let finish;
  const pending = f.feedback.submit(f.button, () => new Promise(done => { finish = done; }));
  f.field.readOnly = true; finish(); await pending;
  assert.equal(f.output().dataset.phase, 'readonly');
  assert.equal(f.button.disabled, true);
  assert.equal(f.confirmations.length, 0);
  f.feedback.destroy();
});

test('destroyed feedback ignores late completion and cancels its existing confirmation', async () => {
  const f = feedbackFixture();
  let finish;
  const pending = f.feedback.submit(f.button, () => new Promise(done => { finish = done; }));
  const previous = f.output();
  f.feedback.destroy(); finish(); await pending;
  assert.equal(f.confirmations.length, 0);
  assert.ok(f.cancellations.includes(previous));
});
test('scoped actions and mode changes never clear unrelated parameter drafts', async () => {
  const f = feedbackFixture();
  const output = input('37');
  const result = await f.feedback.submit(f.button, async () => {}, { inputs:[output] });
  assert.equal(result.ok, true);
  assert.equal(output.dataset.dirty, undefined);
  assert.equal(f.field.dataset.dirty, '1');
  await f.feedback.submit(f.button, async () => {}, { inputs:[] });
  assert.equal(f.field.dataset.dirty, '1');
  assert.equal(f.output().dataset.phase, 'draft');
  f.feedback.destroy();
});
