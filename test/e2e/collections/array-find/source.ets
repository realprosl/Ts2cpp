// V30.8: `find` devuelve el primer elemento que cumple el predicado,
// envuelto en Optional<T>. Con `?? 0` extraemos el valor o un default.
let primero: number = [4, 7, 10].find((n: number): boolean => n > 5) ?? 0;
print(numberToString(primero));   // 7
let ninguno: number = [1, 2, 3].find((n: number): boolean => n > 100) ?? -1;
print(numberToString(ninguno));   // -1 (default)
