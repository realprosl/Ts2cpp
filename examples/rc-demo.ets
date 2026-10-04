// rc-demo.ets — V22 sustituye `Rc<T>` por `ptr<T>` (unique ownership).
//
// V22 (Memory Model v2): `Rc<T>` (shared ownership) se deprecó. El nuevo
// modelo ofrece `ptr<T>` (ownership exclusivo, std::unique_ptr<T>).
// Shared ownership con `weak<T>` se diseñará en un PR futuro.
//
// Mientras tanto, este ejemplo muestra el reemplazo básico: poseemos un
// valor de forma exclusiva y lo pasamos por referencia mutable cuando
// necesitamos que otra función lo modifique.

class Counter {
  value: number;
  constructor(value: number) { this.value = value; }
}

function increment(c: ref<Counter>): void {
  // ref<Counter> es T&: el callee muta el valor del caller.
  c.value = c.value + 1;
}

const counter: Counter = new Counter(10);
increment(counter);
print(numberToString(counter.value));  // 11
