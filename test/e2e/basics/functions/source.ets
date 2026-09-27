// functions — sin/con parámetros, sin/con retorno, recursión.

function greet(): void {
  print("hola");
}
greet();
greet();

// Función con un parámetro y retorno.
function duplicate(x: number): number {
  return x * 2;
}
print("duplicate(5) = " + numberToString(duplicate(5)));
print("duplicate(21) = " + numberToString(duplicate(21)));

// Función con varios parámetros.
function add(a: number, b: number): number {
  return a + b;
}
print("add(3, 4) = " + numberToString(add(3, 4)));

// Función sin valor de retorno explícito (void).
function log(s: string): void {
  print("[log] " + s);
}
log("primer mensaje");
log("segundo mensaje");

// Recursión: factorial.
function factorial(n: number): number {
  if (n <= 1) {
    return 1;
  }
  return n * factorial(n - 1);
}
print("factorial(0) = " + numberToString(factorial(0)));
print("factorial(1) = " + numberToString(factorial(1)));
print("factorial(5) = " + numberToString(factorial(5)));
print("factorial(7) = " + numberToString(factorial(7)));

// Recursión: Fibonacci.
function fib(n: number): number {
  if (n < 2) {
    return n;
  }
  return fib(n - 1) + fib(n - 2);
}
print("fib(0) = " + numberToString(fib(0)));
print("fib(10) = " + numberToString(fib(10)));
