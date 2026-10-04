// mutref-demo.ets — `ref<T>` (referencia mutable, equivalente a T&).
//
// V22 (Memory Model v2): `ref<T>` es el reemplazo directo de `MutRef<T>`.
// El codegen lo traduce a `T&` y pasa el lvalue directamente.
//
// En C++:
//   function increment(c: ref<Counter>): void  →  void increment(Counter& c)
//   increment(c)                               →  increment(c)  (paso por referencia)

class Counter {
  value: number;
  constructor(value: number) { this.value = value; }
}

function increment(c: ref<Counter>): void {
  // Como `c: ref<Counter>` se traduce a `Counter& c`, podemos mutar
  // directamente a través de la referencia.
  c.value = c.value + 1;
}

const counter: Counter = new Counter(99);
increment(counter);
print(numberToString(counter.value));  // 100
