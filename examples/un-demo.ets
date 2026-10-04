// un-demo.ets — V22 sustituye `Unq<T>` por `ptr<T>` (unique ownership).
//
// V22 (Memory Model v2): `Unq<T>` se eliminó en favor de `ptr<T>`, que
// también modela ownership exclusivo (std::unique_ptr<T>) y es move-only.
// Las APIs `unSome<T>(value)`, `unValue(x)`, `unIsSome(x)` se rediseñarán
// en PR#4 (moves) y PR#5 (move semantics).
//
// Mientras tanto, este ejemplo muestra el modelo de propiedad: poseemos
// un valor de forma exclusiva y lo prestamos a otras funciones.

class Counter {
  value: number;
  constructor(value: number) { this.value = value; }
}

function inspect(c: constRef<Counter>): number {
  // constRef<T> permite leer el valor sin posibilidad de mutarlo.
  return c.value;
}

const counter: Counter = new Counter(42);
print(numberToString(inspect(counter)));  // 42
