// match-demo.ets — Fase 1.10: match expressions (TC39 stage 2).
//
// `match (subject) { when (pattern) => result; ... }` desazucara a una
// cadena de comparaciones `(subject == pattern ? result : ...)` con
// short-circuit. Cada arm se evalúa en orden; el primero que matchea
// determina el resultado. El último arm puede ser un wildcard `_` que
// siempre matchea (default).
//
// Limitaciones actuales:
// - Los patterns son expresiones (literales, identifiers). No hay
//   pattern destructuring, rangos, ni type guards.
// - El operador `==` se usa para comparar; en runtime depende de
//   operator== del tipo (no funciona con strings si no se define).

function classify(x: number): string {
  return match (x) {
    when (0) => "zero";
    when (1) => "one";
    when (2) => "two";
    when (3) => "three";
    when (_) => "many";
  };
}

function sign(n: number): string {
  return match (n) {
    when (0) => "zero";
    when (_) => match (n) {
      when (1) => "one";
      when (_) => "many";
    };
  };
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
