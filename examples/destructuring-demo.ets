// destructuring-demo.ets — Bloque D: array destructuring y `readonly` en campos.
//
// Destructuring de arrays: `const [a, b, c] = expr;` se desazucara a una
// variable temporal + N bindings indexados. Cada binding hereda el tipo del
// elemento del initializer (no del array completo). El bloque solo cubre
// destructuring de arrays: el de objetos `{x, y} = ...` no aplica en este
// dialecto porque no hay literales de objeto (sin `Object`/`any`).
//
// Readonly: un campo declarado `readonly x: T` se emite como `T const x` en
// C++. El compilador rechaza reasignaciones posteriores vía `this.x = ...`.
// NOTA: este dialecto todavía no soporta constructores en clases (el parser
// de class body no acepta `constructor`), así que el ejemplo usa inicializadores
// en línea para los campos.

// Destructuring básico
const nums: number[] = [1, 2, 3];
const [first, second, third] = nums;
print(first);          // 1
print(second);         // 2
print(third);          // 3

// Destructuring con tipo declarado por binding
const [x, y]: number[] = [10, 20];
print(x);              // 10
print(y);              // 20

// Destructuring mutable (con `let`)
let [name, surname]: string[] = ["Ana", "López"];
print(name);           // Ana
print(surname);        // López
surname = "García";    // OK: `let` permite reasignar
print(surname);        // García

// Uso en una función: destructuring de un parámetro
function head(arr: string[]): string {
  return arr[0];
}
const [a, b, c]: string[] = ["alpha", "beta", "gamma"];
print(head([a, b, c])); // alpha

// Inicializador con expresión, no literal
const source: number[] = [100, 200, 300, 400];
const [p, q, r]: number[] = source;
print(p + q + r);       // 600
