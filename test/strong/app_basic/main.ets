// V30.52: App que usa la libreria comptime_lib.
// Demuestra cross-module @comptime + comptime() + captura.

import { factorial, fib, isPrime, gcd, pow } from "../comptime_lib/math.ets";

// Sin `function main()`: las statements top-level se ejecutan
// en el ets_init_*, igual que los tests e2e existentes.

// factorial(5) = 120, evaluado estaticamente (literal en cpp).
let f5: number = factorial(5);
print("factorial(5) =");
print(numberToString(f5));

// fib(10) = 55, evaluado estaticamente.
let f10: number = fib(10);
print("fib(10) =");
print(numberToString(f10));

// isPrime(17) = true. comptime con bucles.
if (isPrime(17)) {
  print("isPrime(17) = true");
} else {
  print("isPrime(17) = false");
}

// isPrime(24) = false.
if (isPrime(24)) {
  print("isPrime(24) = true");
} else {
  print("isPrime(24) = false");
}

// gcd(48, 18) = 6. Funcion regular (no @comptime).
print("gcd(48, 18) =");
print(numberToString(gcd(48, 18)));

// pow(2, 10) = 1024. @comptime con recursion.
let p: number = pow(2, 10);
print("pow(2, 10) =");
print(numberToString(p));

// comptime() inline: comptime((): number => 6 * 7) = 42.
let x: number = comptime((): number => 6 * 7);
print("comptime(6*7) =");
print(numberToString(x));
