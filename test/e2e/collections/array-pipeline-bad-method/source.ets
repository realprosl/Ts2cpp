// Test negativo (V7): `arr.bogus(...)` no es un helper válido del dialecto
// (los uses pasan por V7.0 solo emiten filter/map/reduce). El transpile
// debe fallar y los diagnósticos deben mencionar `bogus` y los métodos
// disponibles (`filter`, `map`, `reduce`).

let arr: number[] = [1, 2, 3];
let r = arr.bogus((x: number): boolean => true);