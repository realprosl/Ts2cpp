// optional-demo.ets — Fase 1.2: `Optional<T>` runtime + dialecto.
//
// `Optional<T>` es el envoltorio de `std::optional<T>` con API ergonómica
// (isPresent, valueOr, map, andThen, orElse). Reemplaza el "ausente" del
// dialecto sin reintroducir null/undefined.
//
// API expuesta (como funciones libres porque el dialecto aún no soporta
// métodos sobre tipos genéricos como `Optional<T>`):
//
//   optionalSome(value)    → Optional<T>
//   optionalNone<T>()      → Optional<T>
//   optionalIsPresent(opt) → boolean
//   optionalValueOr(opt, defaultValue) → T
//   optionalMap(opt, f)    → Optional<U>
//   optionalAndThen(opt, f) → Optional<U>
//   optionalOrElse(opt, other) → Optional<T>

// Helper que demuestra `some`/`none`/`valueOr`.
function findFirstPositive(arr: number[]): Optional<number> {
  let result: Optional<number> = optionalNone<number>();
  for (const x of arr) {
    if (optionalIsPresent(result)) break;
    if (x > 0) result = optionalSome(x);
  }
  return result;
}

const positives: number[] = [10, 20, 30];
const found: Optional<number> = findFirstPositive(positives);
print(optionalValueOr(found, -1));            // 10

const allNegative: number[] = [-1, -2, -3];
const notFound: Optional<number> = findFirstPositive(allNegative);
print(optionalValueOr(notFound, -1));        // -1 (default)

// `optionalMap`: si presente, transforma; si no, sigue siendo None.
const doubled: Optional<number> = optionalMap(found, (n: number): number => n * 2);
print(optionalValueOr(doubled, 0));          // 20

const doubledEmpty: Optional<number> = optionalMap(notFound, (n: number): number => n * 2);
print(optionalValueOr(doubledEmpty, 0));     // 0 (default)
print(optionalIsPresent(doubledEmpty));      // false (0)

// `optionalAndThen`: encadena operaciones que devuelven Optional.
function safeDivide(a: number, b: number): Optional<number> {
  if (b == 0) return optionalNone<number>();
  return optionalSome(a / b);
}

const chain: Optional<number> = optionalAndThen(found, (n: number): Optional<number> => safeDivide(n, 2));
print(optionalValueOr(chain, -1));           // 5

const chainEmpty: Optional<number> = optionalAndThen(notFound, (n: number): Optional<number> => safeDivide(n, 2));
print(optionalValueOr(chainEmpty, -1));      // -1

// `optionalOrElse`: si vacío, devuelve otro Optional.
const fallback: Optional<number> = optionalOrElse(notFound, optionalSome(0));
print(optionalValueOr(fallback, -1));        // 0
