// spread-array-demo.ets — Bloque 4: spread operator en array literals.
//
// El operador `...` "expande" los elementos de un vector (o tupla) dentro
// del nuevo literal. Solo se admite en arrays (`T[]`), no en tuplas de
// tamaño fijo.
//
// Restricciones del dialecto:
//   - El operando del spread debe ser del mismo tipo (vector o tupla).
//   - No hay soporte para nested spreads (`[...a, ...[1,2,3]]`).

const a: number[] = [1, 2, 3];
const b: number[] = [4, 5, 6];

// Concatenar dos arrays.
const combined: number[] = [...a, ...b];
print(length(combined));  // 6
print(combined[0]);       // 1
print(combined[5]);       // 6

// Spread al principio y en el medio.
const prefix: number[] = [0, ...a, 99];
print(length(prefix));    // 5
print(prefix[0]);         // 0
print(prefix[1]);         // 1
print(prefix[3]);         // 3
print(prefix[4]);         // 99

// Mezcla con valores literales.
const mixed: number[] = [10, ...a, 20, ...b, 30];
print(length(mixed));     // 9
print(mixed[0]);          // 10
print(mixed[1]);          // 1
print(mixed[4]);          // 20
print(mixed[8]);          // 30
