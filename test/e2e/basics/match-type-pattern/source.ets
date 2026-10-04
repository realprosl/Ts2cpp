// type-pattern: whenType<T>(callback) narrowa el subject via
// std::holds_alternative + std::get (V23.2). El callback se invoca
// con 0 args y se discrimina por el T de cada whenType.
function f(v: number | string): string {
  return match(v, [
    whenType<number>(() => "num"),
    whenType<string>(() => "str"),
  ]);
}

print(f(42));
print(f("hi"));
