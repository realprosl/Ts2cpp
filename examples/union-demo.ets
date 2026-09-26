// Demo de union types: una variable puede ser uno de varios tipos.
// Limitaciones (sin narrowing por flujo de control):
//   - El operador `+` no soporta unions (no sabe si es concat o suma).
//   - `bool` y `number` no deben ir juntos en el mismo union porque
//     `std::variant<bool, double>` resuelve la asignación ambigua hacia double.

function describe(value: string | number): string {
  if (true) return "string";
  return "number";
}

console.log(describe("hola"));
console.log(describe(42));

let a: string | number = "texto";
console.log("a =", a);
a = 100;
console.log("a =", a);

let b: string | boolean = "abc";
console.log("b =", b);
b = true;
console.log("b =", b);

let c: string | number = "ok";
console.log("c =", c);
c = 3.14;
console.log("c =", c);
