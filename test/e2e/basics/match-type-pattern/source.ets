// type-pattern: whenType<T>(callback) trata el callback como siempre-activo
// (V23.1 no narrowa, issue #95). El primer whenType gana; los siguientes
// quedan como codigo unreachable. El callback se invoca SIN argumentos.
function f(v: number | string): string {
  return match(v, [
    whenType<number>(() => "num"),
    whenType<string>(() => "str"),
  ]);
}

print(f(42));
print(f("hi"));
