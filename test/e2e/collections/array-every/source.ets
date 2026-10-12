// V30.8: `every` devuelve true si TODOS los elementos cumplen el predicado.
print([1, 2, 3].every((n: number): boolean => n > 0) ? "true" : "false");
print([1, 2, -3].every((n: number): boolean => n > 0) ? "true" : "false");
