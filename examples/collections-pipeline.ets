// V7.0 — `filter`, `map`, `reduce` sobre `T[]`.
//
// El dialecto no soporta métodos sobre tipos genéricos parametrizados como
// `T[]`, así que `arr.filter(p)` se reescribe en el codegen a una llamada
// a las plantillas libres `ets_filter_vec<T>`, `ets_map_vec<T, U>` y
// `ets_reduce<U, T>` definidas en `runtime/ets_collections.hpp` (V7.0;
// V7.1 las fusionará en un único bucle cuando se encadenen).
//
// API del dialecto:
//   arr.filter((item: T) => boolean): T[]
//   arr.map<U>((item: T) => U): U[]
//   arr.reduce<U>(init: U, op: (acc: U, item: T) => U): U
//
// `U` debe declararse explícitamente en `map`/`reduce` (el dialecto aún no
// infiere tipos desde lambdas en el call site; V7.1 lo relajará cuando
// fusione las cadenas).

// --- Caso 1: filter solo -----------------------------------------------
// Filtrar los números pares de un array.
let numbers: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
let evens: number[] = numbers.filter((x: number): boolean => x % 2 == 0);
print("evens count: ", numberToString(length(evens)));
print("first even: ", numberToString(evens[0]));
print("last even: ", numberToString(evens[length(evens) - 1]));

// --- Caso 2: map solo --------------------------------------------------
// Convertir números a strings.
let strings: string[] = numbers.map<string>((x: number): string => numberToString(x));
print("first string: ", strings[0]);
print("last string: ", strings[length(strings) - 1]);

// --- Caso 3: reduce solo -----------------------------------------------
// Sumar todos los elementos.
let total: number = numbers.reduce<number>(0, (acc: number, x: number): number => acc + x);
print("total: ", numberToString(total));

// `init` se respeta si el array está vacío.
let empty: number[] = [];
let emptyTotal: number = empty.reduce<number>(42, (acc: number, x: number): number => acc + x);
print("empty total: ", numberToString(emptyTotal));

// --- Caso 4: cadena filter → map → reduce ------------------------------
// Suma de las longitudes de los strings que representan números pares.
// Esto es exactamente el patrón que V7.1 fusionará a un único `for`.
let sumLengths: number = numbers
  .filter((x: number): boolean => x % 2 == 0)
  .map<string>((x: number): string => numberToString(x))
  .reduce<number>(0, (acc: number, s: string): number => acc + length(s));
print("sum of lengths: ", numberToString(sumLengths));

// --- Caso 5: side effects en orden -------------------------------------
// Las lambdas se invocan en el orden del array, una vez por elemento.
// Aquí se cuenta cuántos items visita `filter` (incluso los descartados)
// para demostrar que `filter` visita todos los items y que el orden se
// preserva. La mutación de la variable capturada activa la captura por
// referencia `[&]` en el codegen.
let calls: number = 0;
let lastSeen: number = 0;
let sideEffectSum: number = [10, 20, 30, 40, 50]
  .filter((x: number): boolean => {
    calls = calls + 1;
    lastSeen = x;
    return x > 25;
  })
  .reduce<number>(0, (acc: number, x: number): number => acc + x);
print("side effect sum: ", numberToString(sideEffectSum));
print("side effect count: ", numberToString(calls));
print("side effect lastSeen: ", numberToString(lastSeen));