// V7.0: pipeline filter → map → reduce sobre `T[]`.
//
// El dialecto reescribe `arr.filter(p)` a `ets_filter_vec<T>(arr, p)`,
// `arr.map<U>(f)` a `ets_map_vec<T, U>(arr, f)`, y `arr.reduce<U>(init, op)`
// a `ets_reduce<U, T>(init, arr, op)`. Para V7.0 se emiten llamadas
// independientes (sin fusión); V7.1 las fusionará en un único bucle cuando
// la cadena sea fusible.
//
// El test verifica:
//   1. `filter` devuelve un nuevo vector preservando orden y tipo.
//   2. `map` transforma cada elemento y respeta el typeArgument `U`.
//   3. `reduce` pliega el vector desde `init` y respeta `init` si el
//      vector está vacío.
//   4. La cadena `filter → map → reduce` produce el resultado correcto
//      (orden estable, side-effects en orden).

let arr: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// filter: solo pares
let evens: number[] = arr.filter((x: number): boolean => x % 2 == 0);
print(numberToString(length(evens)));        // 5
print(numberToString(evens[0]));             // 2
print(numberToString(evens[length(evens) - 1])); // 10

// map: cada número a string
let strings: string[] = arr.map<string>((x: number): string => numberToString(x));
print(strings[0]);                            // "1"
print(strings[length(strings) - 1]);          // "10"

// reduce: suma
let total: number = arr.reduce<number>(0, (acc: number, x: number): number => acc + x);
print(numberToString(total));                 // 55

// reduce sobre array vacío respeta init
let empty: number[] = [];
let emptyTotal: number = empty.reduce<number>(42, (acc: number, x: number): number => acc + x);
print(numberToString(emptyTotal));            // 42

// Cadena filter → map → reduce: suma de longitudes de los pares en string
let sumLengths: number = arr
  .filter((x: number): boolean => x % 2 == 0)
  .map<string>((x: number): string => numberToString(x))
  .reduce<number>(0, (acc: number, s: string): number => acc + length(s));
print(numberToString(sumLengths));            // 1+1+1+1+2 = 6