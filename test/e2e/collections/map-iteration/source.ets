// map-iteration — recorre todas las entradas de un `Map<K, V>`.
//
// El dialecto soporta `for..of` sobre Map; cada iteración produce una
// tupla `[K, V]` que se desestructura con `pair[0]` y `pair[1]`. Aquí
// sumamos los valores y contamos entradas para validar la iteración.

let totals: Map<string, number> = new Map<string, number>();
totals.set("a", 1);
totals.set("b", 2);
totals.set("c", 3);
totals.set("d", 4);

let sum: number = 0;
let count: number = 0;
for (const pair of totals) {
  sum = sum + pair[1];
  count = count + 1;
}

print(numberToString(sum));
print(numberToString(count));
print(numberToString(totals.size()));
