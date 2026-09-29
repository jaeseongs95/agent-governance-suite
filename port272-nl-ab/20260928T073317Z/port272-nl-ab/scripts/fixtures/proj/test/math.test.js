const test = require("node:test");
const assert = require("node:assert");
const { sum, average } = require("../math");

test("sum adds all values", () => {
  assert.strictEqual(sum([1, 2, 3]), 6);
});

test("average of empty list is 0", () => {
  assert.strictEqual(average([]), 0);
});

test("average of values", () => {
  assert.strictEqual(average([2, 4, 6]), 4);
});
