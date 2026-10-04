// mut-demo.ets — `ref<T>` (referencia mutable, equivalente a T&).
//
// V22 (Memory Model v2): `ref<T>` se usa como tipo de parámetro para
// indicar que la función puede mutar el objeto referenciado. El codegen
// lo traduce a `T&` y pasa el lvalue directamente.
//
// En C++:
//   function bump(p: ref<Counter>): void  →  void bump(Counter& p)
//   bump(c)                               →  bump(c)  (paso por referencia)

class Counter {
  value: number;
  constructor(value: number) { this.value = value; }
}

function bump(p: ref<Counter>): void {
  // Como `p: ref<Counter>` se traduce a `Counter& p`, podemos mutar
  // directamente a través de la referencia.
  p.value = p.value + 1;
  print(numberToString(p.value));
}

const c: Counter = new Counter(7);
bump(c);
print(numberToString(c.value));  // 8 (mutado a través de la referencia)
