// while-loop — bucle con acumulador y conteo.

function sumTo(n: number): number {
  let acc: number = 0;
  let i: number = 1;
  while (i <= n) {
    acc = acc + i;
    i = i + 1;
  }
  return acc;
}

print("sumTo(0)  = " + numberToString(sumTo(0)));
print("sumTo(1)  = " + numberToString(sumTo(1)));
print("sumTo(5)  = " + numberToString(sumTo(5)));
print("sumTo(10) = " + numberToString(sumTo(10)));

// Cuenta regresiva.
let n: number = 5;
while (n > 0) {
  print("count = " + numberToString(n));
  n = n - 1;
}
print("done");

// Doble paso (de 2 en 2).
let even: number = 0;
while (even < 10) {
  print("even = " + numberToString(even));
  even = even + 2;
}
