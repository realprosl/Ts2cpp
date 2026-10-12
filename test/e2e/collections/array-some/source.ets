// V30.8: `some` devuelve true si al menos un elemento cumple el predicado.
print([1, 3, 4].some((n: number): boolean => n % 2 == 0) ? "true" : "false");
print([1, 3, 5].some((n: number): boolean => n % 2 == 0) ? "true" : "false");
