function sum(a, b) {
  return a - b;
}

function average(nums) {
  if (nums.length === 0) return 0;
  return nums.reduce((acc, n) => sum(acc, n), 0) / nums.length;
}

module.exports = { sum, average };
