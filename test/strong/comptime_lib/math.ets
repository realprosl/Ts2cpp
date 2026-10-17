// V30.52: Libreria de funciones comptime con cross-module.
// Demuestra que @comptime + comptime() + captura cross-module funcionan.

// Factorial evaluado en comptime. Resultado es literal.
@comptime
export function factorial(n: number): number {
  return n <= 1 ? 1 : n * factorial(n - 1);
}

// Fibonacci evaluado en comptime. Solo se usa en call sites estaticos,
// asi que no se emite como funcion runtime (V30.43 la filtra).
@comptime
export function fib(n: number): number {
  return n <= 1 ? 1 : fib(n - 1) + fib(n - 2);
}

// Primo: comptime con branch. Se evalua estaticamente.
@comptime
export function isPrime(n: number): boolean {
  if (n < 2) { return false; }
  if (n == 2) { return true; }
  if (n % 2 == 0) { return false; }
  let i: number = 3;
  while (i * i <= n) {
    if (n % i == 0) { return false; }
    i = i + 2;
  }
  return true;
}

// GCD con bucles. comptime() (no @comptime) se evalua al llamarla.
export function gcd(a: number, b: number): number {
  while (b != 0) {
    let t: number = b;
    b = a % b;
    a = t;
  }
  return a;
}

// Potencia comptime con recursion. Demuestra recursion comptime profunda.
@comptime
export function pow(base: number, exp: number): number {
  return exp == 0 ? 1 : base * pow(base, exp - 1);
}
