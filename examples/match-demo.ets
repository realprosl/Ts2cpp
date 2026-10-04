// match-demo.ets — V23: match intrinsics con sintaxis compatible con TypeScript.
//
// `match(value, [when(pattern, callback), ...])` desazucara a un
// if/else chain (IIFE) que se compila a codigo C++ nativo, sin pasar
// por una llamada a funcion. Cada arm se evalua en orden; el primero
// que matchea determina el resultado. El ultimo arm puede ser un
// `otherwise(callback)` que actua como default.
//
// Diferencias con la forma TC39 (V1.10, eliminada en V23):
// - Los callbacks son arrow functions con tipo explicito: `(v: T): R => expr`.
//   El dialecto requiere anotacion de tipo en lambdas (no hay inferencia
//   contextual como en TypeScript).
// - Los patterns son expresiones que se comparan con `==` (literales,
//   identifiers). No hay pattern destructuring ni rangos.
// - Para type dispatching, usa `whenType<T>(callback)`. En V23.1 NO
//   narrowa el subject (issue #95): el callback se invoca sin
//   argumentos. Para narrowing real, usa la forma V2 destructurada.
//
// Ver `docs/match-syntax.md` para la especificacion completa.

function classify(x: number): string {
  return match(x, [
    when(0, (v: number): string => "zero"),
    when(1, (v: number): string => "one"),
    when(2, (v: number): string => "two"),
    when(3, (v: number): string => "three"),
    otherwise((): string => "many"),
  ]);
}

function sign(n: number): string {
  return match(n, [
    when(0, (v: number): string => "zero"),
    otherwise((): string => match(n, [
      when(1, (v: number): string => "one"),
      otherwise((): string => "many"),
    ])),
  ]);
}

print(classify(0));   // zero
print(classify(1));   // one
print(classify(2));   // two
print(classify(3));   // three
print(classify(42));  // many

print(sign(0));   // zero
print(sign(1));   // one
print(sign(2));   // many
print(sign(5));   // many
