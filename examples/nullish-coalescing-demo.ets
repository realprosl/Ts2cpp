// nullish-coalescing-demo.ets — Fase 1.3: operador `??` sobre Optional<T>.
//
// `expr ?? default` devuelve `default` cuando `expr` es `Optional<T>` vacío,
// o el valor desempaquetado cuando tiene contenido. Es syntactic sugar
// sobre `optionalValueOr(expr, default)` con type-check de que el LHS
// es `Optional<T>` y el default es de tipo `T`.

function findPositive(arr: number[]): Optional<number> {
  let result: Optional<number> = optionalNone<number>();
  for (const x of arr) {
    if (optionalIsPresent(result)) break;
    if (x > 0) result = optionalSome(x);
  }
  return result;
}

// Caso 1: presente.
const positives: number[] = [10, 20, 30];
print(findPositive(positives) ?? -1);     // 10

// Caso 2: ausente, usa el default.
const allNegative: number[] = [-1, -2, -3];
print(findPositive(allNegative) ?? -1);  // -1

// Caso 3: con strings.
function firstNonEmpty(arr: string[]): Optional<string> {
  let result: Optional<string> = optionalNone<string>();
  for (const s of arr) {
    if (optionalIsPresent(result)) break;
    if (length(s) > 0) result = optionalSome(s);
  }
  return result;
}
const tags: string[] = [];
print(firstNonEmpty(tags) ?? "(none)");          // (none)
const names: string[] = ["alice", "bob"];
print(firstNonEmpty(names) ?? "(none)");         // alice

// Caso 4: encadenado con map.
const value: Optional<number> = findPositive([5]);
print(optionalMap(value, (n: number): number => n * 2) ?? 0);  // 10
