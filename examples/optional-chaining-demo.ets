// optional-chaining-demo.ets — Fase 1.4: operador `?.` sobre Optional<T>.
//
// `obj?.field` desazucara a `optionalAndThen(obj, e => optionalSome(e.field))`.
// Si `obj` es `Optional<T>` con T que tiene `field`, el resultado es
// `Optional<typeof field>`. Encadenable con `??` para defaults.

class Box { value: number; }

function maybeBox(b: boolean): Optional<Box> {
  if (b) return optionalSome<Box>(new Box(42));
  return optionalNone<Box>();
}

// Caso 1: presente.
const present: Optional<Box> = maybeBox(true);
const v1: Optional<number> = present?.value;
print(v1 ?? -1);     // 42

// Caso 2: ausente, usa el default.
const absent: Optional<Box> = maybeBox(false);
const v2: Optional<number> = absent?.value;
print(v2 ?? -1);     // -1

// Encadenado: Optional<Box> -> Optional<number> -> number.
const chained: Optional<number> = maybeBox(true)?.value;
print(chained ?? -1);   // 42
