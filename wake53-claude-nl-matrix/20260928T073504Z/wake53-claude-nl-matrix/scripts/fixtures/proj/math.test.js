const test = require('node:test');
const assert = require('node:assert');
const { sum, average } = require('./math.js');

test('sum adds two numbers', () => {
  assert.strictEqual(sum(2, 3), 5);
});

test('average of empty list is 0', () => {
  assert.strictEqual(average([]), 0);
});

test('average of numbers', () => {
  assert.strictEqual(average([2, 4, 6]), 4);
});
