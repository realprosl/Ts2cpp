// V1.3 — print(union) + comparación contextual por discriminador.
// Demuestra que las tagged unions se imprimen legiblemente (sin revelar
// el std::variant subyacente) y que `==` dispatcha por discriminador:
// iguales solo si misma variante + mismo payload.
//
// Nota: el dialecto reserva `ok` como helper global para envolver
// `Result<T>`, por eso las variables locales se llaman `r1`, `r2`, ...

union Shape = Circle | Square;
union Outcome<T, E> = Ok(T) | Err(E);

let r1: Outcome<number, string> = Outcome<number, string>.Ok(42);
let r2: Outcome<number, string> = Outcome<number, string>.Err("boom");
print(r1);                          // Ok(42)
print(r2);                          // Err(boom)

// Misma variante, mismo payload → igual.
let r3: Outcome<number, string> = Outcome<number, string>.Ok(42);
if (r1 == r3) { print("r1 == r3"); }

// Misma variante, payload distinto → desigual.
let r4: Outcome<number, string> = Outcome<number, string>.Ok(7);
if (r1 != r4) { print("r1 != r4"); }

// Distinta variante → desigual.
if (r1 != r2) { print("r1 != r2"); }

// Variante nula.
let s1: Shape = Shape.Circle();
let s2: Shape = Shape.Square();
print(s1);                          // Circle
print(s2);                          // Square
if (s1 != s2) { print("s1 != s2"); }