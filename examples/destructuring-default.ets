// destructuring-default.ets — Bloque 5: default values en array destructuring.
//
// Sintaxis: `const [a = expr] = arr` toma `expr` cuando el binding no tiene
// un elemento correspondiente en el initializer (porque arr es más corto).
//
// Restricciones:
//   - El initializer debe ser un array (`T[]`). Para tuplas de tamaño fijo
//     no tiene sentido (el tamaño es siempre N).
//   - El tipo del default debe coincidir con el del binding.
//   - Solo se aplica al final: si arr tiene N elementos y se piden N+K
//     bindings, los últimos K obtienen sus defaults. Los primeros N
//     bindings acceden normalmente a arr[0..N).

// Caso 1: array corto, todos los bindings obtienen default.
const empty: number[] = [];
const [x = 1, y = 2, z = 3] = empty;
print(x);  // 1
print(y);  // 2
print(z);  // 3

// Caso 2: array más corto, defaults al final.
const two: number[] = [10, 20];
const [a = 1, b = 2, c = 3] = two;
print(a);  // 10
print(b);  // 20
print(c);  // 3 (default)

// Caso 3: array exactamente del tamaño, no se usan defaults.
const three: number[] = [100, 200, 300];
const [p = 1, q = 2, r = 3] = three;
print(p);  // 100
print(q);  // 200
print(r);  // 300

// Caso 4: defaults con strings.
const tags: string[] = ["alpha"];
const [t1 = "default", t2 = "fallback"] = tags;
print(t1);  // alpha
print(t2);  // fallback
