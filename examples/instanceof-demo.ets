// Demo de `instanceof`:
//   - Sobre uniones, valida en runtime con `std::holds_alternative<T>(v)`.
//   - Sobre clases (sin herencia dinámica en etsc), la verificación es
//     estática y siempre verdadera; el codegen emite `true`.

// Las dos pruebas se hacen dentro de funciones para que `v` se evalúe
// secuencialmente (en el nivel superior, `let` se inicializa estáticamente
// antes de que se ejecuten las asignaciones de `main`).
function checkString(v: string | number): void {
  if (v instanceof string) print("string"); else print("number");
}
function checkNumber(v: string | number): void {
  if (v instanceof number) print("number"); else print("string");
}
function checkClass(): void {
  // `instanceof` sobre un tipo que no es unión: el codegen emite `true`
  // porque etsc no tiene herencia dinámica.
  let x: number = 42;
  if (x instanceof number) print("number-class"); else print("other");
}

let v: string | number = "hi";
checkString(v);   // string
v = 42;
checkNumber(v);   // number
checkClass();      // number-class
