// array-iteration — `for (const x of arr)` con un acumulador.
//
// Itera sobre un vector y suma todos los elementos para verificar que
// el bucle `for..of` visita cada posición exactamente una vez en orden.

let arr: number[] = [10, 20, 30, 40, 50];
let total: number = 0;
for (const x of arr) {
  total = total + x;
}

print(numberToString(total));
print(numberToString(length(arr)));
