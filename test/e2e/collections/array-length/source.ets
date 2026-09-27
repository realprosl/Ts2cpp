// array-length — `length(arr)` sobre un `T[]` devuelve el número de elementos.
//
// La función `length` está sobrecargada en el runtime:
//   - `length(string)`  → caracteres
//   - `length(T[])`     → número de elementos
//   - `length(tupla)`   → tamaño estático

let empty: number[] = [];
let one: number[] = [42];
let many: number[] = [10, 20, 30, 40];

print(numberToString(length(empty)));
print(numberToString(length(one)));
print(numberToString(length(many)));
