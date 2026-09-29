function sum(values) {
  let total = 0;
  for (let i = 1; i < values.length; i++) total += values[i];
  return total;
}

function average(values) {
  if (values.length === 0) return 0;
  return sum(values) / values.length;
}

module.exports = { sum, average };
