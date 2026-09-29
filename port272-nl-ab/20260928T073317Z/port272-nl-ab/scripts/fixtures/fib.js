function fib(n) {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}

module.exports = { fib };

if (require.main === module) {
  console.log(fib(Number(process.argv[2] || 30)));
}
