// un-demo.ets — `Un<T>` (smart pointer con ownership único, equivalente a
// std::unique_ptr<T>).
//
// `Un<T>` se construye con `unSome<T>(value)` y se destruye automáticamente
// al salir del scope. Es move-only: no se puede copiar.

class Counter {
  value: number;
  constructor(value: number) { this.value = value; }
}

function makeCounter(): Un<Counter> {
  return unSome<Counter>(new Counter(42));
}

function inspect(c: Un<Counter>): number {
  if (unIsSome(c)) return unValue(c).value;
  return -1;
}

const counter: Un<Counter> = makeCounter();
print(numberToString(inspect(counter)));
