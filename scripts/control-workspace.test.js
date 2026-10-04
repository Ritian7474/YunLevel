'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SelectionStore, entries, parameterPolicy } = require('../public/control-workspace');
const { rangeFor } = require('../public/parameter-slider');
const loops = [{ mv: 1, pv: 0 }, { mv: 2, pv: 1 }, { mv: 0, pv: 2 }];

test('selection follows the same loop when indices shift after a deletion', () => {
  const store = new SelectionStore();
  const initial = entries(loops, []);
  store.update('tank', initial);
  store.select('tank', initial[2].key);
  const selected = store.update('tank', entries(loops.slice(1), []));
  assert.equal(selected.key, initial[2].key);
  assert.equal(selected.index, 1);
});
test('deleting the selected loop chooses the next surviving loop, then clears on empty', () => {
  const store = new SelectionStore();
  const initial = entries(loops, []);
  store.update('tank', initial);
  store.select('tank', initial[1].key);
  assert.equal(store.update('tank', entries([loops[0], loops[2]], [])).key, initial[2].key);
  assert.equal(store.update('tank', []), null);
  assert.equal(store.current('tank'), null);
});
test('tank and HX selections are independent during model round trips', () => {
  const store = new SelectionStore();
  const tank = entries(loops, []);
  store.update('tank', tank);
  store.select('tank', tank[1].key);
  store.update('hx', entries([{ mv: 0, pv: 0 }], []));
  assert.equal(store.update('tank', tank).key, tank[1].key);
});
test('loop and cascade identities cannot collide and use their own command indices', () => {
  const all = entries(loops.slice(0, 1), [{ mv: 1, outer: 0, inner: 3 }]);
  assert.notEqual(all[0].key, all[1].key);
  assert.deepEqual(all.map(x => [x.kind, x.index]), [['loop', 0], ['casc', 0]]);
});
test('repeated identities have unique UI keys and unknown keys do not change selection', () => {
  const all = entries([loops[0], loops[0]], []);
  assert.notEqual(all[0].key, all[1].key);
  const store = new SelectionStore();
  store.update('tank', all);
  assert.equal(store.select('tank', 'stale-loop'), null);
  assert.equal(store.current('tank').key, all[0].key);
});
test('new sessions can clear all model selections', () => {
  const store = new SelectionStore();
  store.update('tank', entries(loops, []));
  store.clear();
  assert.equal(store.current('tank'), null);
});
test('HX inlet manual slider uses temperature bounds instead of valve percent bounds', () => {
  const policy = parameterPolicy({ manual:true, label:'TI1103 入口蒸汽 ℃', min:'250', max:'650', step:'1' });
  const range = rangeFor(policy, '400');
  assert.equal(range.outOfBounds, false);
  assert.deepEqual([range.min, range.max, range.step, range.value], [250, 650, 1, 400]);
});
test('manual valve and pump sliders preserve source limits and percentage defaults', () => {
  for (const input of [{ min:'0', max:'100', step:'1' }, { min:'', max:'', step:'' }]) {
    const range = rangeFor(parameterPolicy({ manual:true, ...input }), '60');
    assert.deepEqual([range.min, range.max, range.step, range.outOfBounds], [0, 100, 1, false]);
  }
});
test('cascade Ti and temperature SP retain their distinct finite and infinity policies', () => {
  assert.equal(rangeFor(parameterPolicy({ field:'innerTi', label:'副环 Ti' }), 'inf').infinity, true);
  const sp = rangeFor(parameterPolicy({ field:'outerSp', label:'主环 SP ℃' }), '450');
  assert.deepEqual([sp.min, sp.max, sp.value, sp.outOfBounds], [250, 650, 450, false]);
});
