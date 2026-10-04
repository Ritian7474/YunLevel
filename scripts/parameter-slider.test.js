'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rangeFor } = require('../public/parameter-slider.js');

const ti = { min: 0.1, max: 300, step: 0.1, allowInfinity: true };
const percent = { min: 0, max: 100, step: 1, hardMin: 0, hardMax: 100 };

test('Ti inf, infinity symbol and finite negative values disable integration without a negative range', () => {
  for (const raw of ['inf', ' INF ', '∞', '-1', '-200.25']) {
    const result = rangeFor(ti, raw, 12.5);
    assert.equal(result.infinity, true, raw);
    assert.equal(result.invalid, false, raw);
    assert.equal(result.finiteValue, null, raw);
    assert.equal(result.value, 12.5, raw);
    assert.equal(result.rememberedFinite, 12.5, raw);
    assert.ok(result.min > 0, raw);
  }
});

test('Ti remembers a positive finite draft for the next transition out of inf', () => {
  const finite = rangeFor(ti, '38.25', 15);
  const off = rangeFor(ti, 'inf', finite.rememberedFinite);
  assert.equal(finite.finiteValue, 38.25);
  assert.equal(off.rememberedFinite, 38.25);
  assert.equal(off.value, 38.25);
});

test('Ti without usable memory restores an allowed positive lower limit', () => {
  for (const memory of [undefined, '', NaN, Infinity, -1, 0]) {
    const result = rangeFor(ti, 'inf', memory);
    assert.equal(result.value, 0.1);
    assert.equal(result.rememberedFinite, 0.1);
  }
  const noPositiveMin = rangeFor({ min: 0, max: 100, step: 0.25, allowInfinity: true }, 'inf');
  assert.equal(noPositiveMin.min, 0.25);
});

test('Ti zero and invalid or empty drafts remain invalid rather than becoming inf', () => {
  for (const raw of ['0', '-0', '', '  ', 'oops', 'Infinity', '1e999']) {
    const result = rangeFor(ti, raw, 20);
    assert.equal(result.invalid, true, raw);
    assert.equal(result.infinity, false, raw);
    assert.equal(result.finiteValue, null, raw);
    assert.equal(result.value, 20, raw);
  }
});

test('soft bounds include large positive, negative and decimal finite drafts', () => {
  const policy = { min: 0, max: 10, step: 0.01 };
  assert.deepEqual(rangeFor(policy, '27.125'), {
    min: 0, max: 27.125, step: 0.01, value: 27.125, finiteValue: 27.125,
    rememberedFinite: 27.125, infinity: false, invalid: false, outOfBounds: false
  });
  const negative = rangeFor(policy, '-4.875');
  assert.equal(negative.min, -4.875);
  assert.equal(negative.max, 10);
  assert.equal(negative.value, -4.875);
});

test('positive Ti values below and above the soft bounds expand the slider', () => {
  const small = rangeFor(ti, '0.025');
  const large = rangeFor(ti, '2500');
  assert.equal(small.min, 0.025);
  assert.equal(small.value, 0.025);
  assert.equal(large.max, 2500);
  assert.equal(large.value, 2500);
  const off = rangeFor(ti, '∞', large.rememberedFinite);
  assert.equal(off.max, 2500);
  assert.equal(off.value, 2500);
});

test('hard bounds constrain the thumb without changing the parsed source value', () => {
  const low = rangeFor(percent, '-25', 40);
  const high = rangeFor(percent, '150.5', 40);
  assert.equal(low.min, 0);
  assert.equal(low.value, 0);
  assert.equal(low.finiteValue, -25);
  assert.equal(low.outOfBounds, true);
  assert.equal(low.rememberedFinite, 40);
  assert.equal(high.max, 100);
  assert.equal(high.value, 100);
  assert.equal(high.finiteValue, 150.5);
  assert.equal(high.outOfBounds, true);
  assert.equal(high.rememberedFinite, 40);
});

test('hard boundaries themselves are valid, including numeric string policies', () => {
  const policy = { min: '-5', max: '15', step: '0.25', hardMin: '0', hardMax: '10' };
  const zero = rangeFor(policy, '0');
  const ten = rangeFor(policy, '10');
  assert.equal(zero.min, 0);
  assert.equal(zero.max, 10);
  assert.equal(zero.step, 0.25);
  assert.equal(zero.outOfBounds, false);
  assert.equal(ten.outOfBounds, false);
});

test('a single hard boundary still allows growth on the opposite side', () => {
  const lowerOnly = rangeFor({ min: 0, max: 10, hardMin: 0 }, '35');
  const upperOnly = rangeFor({ min: 0, max: 10, hardMax: 100 }, '-8');
  assert.equal(lowerOnly.max, 35);
  assert.equal(upperOnly.min, -8);
  assert.equal(lowerOnly.outOfBounds, false);
  assert.equal(upperOnly.outOfBounds, false);
});

test('Ti finite memory respects hard bounds when restoring integration', () => {
  const policy = { ...ti, hardMin: 1, hardMax: 60 };
  const result = rangeFor(policy, 'inf', 100);
  assert.equal(result.value, 60);
  assert.equal(result.rememberedFinite, 60);
  assert.equal(result.min, 1);
  assert.equal(result.max, 60);
});

test('empty and invalid numeric drafts use memory without interpreting blank text as zero', () => {
  for (const raw of ['', '  ', null, undefined, 'bad', '∞', 'inf', 'Infinity']) {
    const result = rangeFor({ min: -10, max: 10, step: 0.1 }, raw, 2.5);
    assert.equal(result.invalid, true, String(raw));
    assert.equal(result.value, 2.5, String(raw));
    assert.equal(result.finiteValue, null, String(raw));
    assert.equal(result.infinity, false, String(raw));
  }
});

test('decimal and exponent drafts retain their finite precision and configured step', () => {
  for (const [raw, value] of [['0.333333', 0.333333], ['1e-4', 0.0001], [' -1.25 ', -1.25]]) {
    const result = rangeFor({ min: -2, max: 2, step: 0.001 }, raw);
    assert.equal(result.finiteValue, value);
    assert.equal(result.value, value);
    assert.equal(result.step, 0.001);
    assert.equal(result.invalid, false);
  }
});

test('invalid step falls back to one and impossible hard policies fail explicitly', () => {
  for (const step of [0, -1, Infinity, '', 'bad']) assert.equal(rangeFor({ step }, '5').step, 1);
  assert.throws(() => rangeFor({ hardMin: 10, hardMax: 5 }, '7'), RangeError);
  assert.throws(() => rangeFor({ ...ti, hardMax: 0 }, 'inf'), RangeError);
});
