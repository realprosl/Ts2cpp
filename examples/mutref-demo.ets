// mutref-demo.ets — `MutRef<T>` (alias mutable).
//
// `MutRef<T>` se usa como tipo de parámetro para indicar que la función
// recibe una referencia mutable al objeto del caller.
//
// En C++:
//   function increment(ref: MutRef<Counter>): void  →  void increment(Counter& ref)
//   increment(c)                                     →  increment(c)  (paso por referencia)

class Counter {
  value: number;
  constructor(value: number) { this.value = value; }
}

function increment(ref: MutRef<Counter>): void {
  // Como `ref: MutRef<Counter>` se traduce a `Counter& ref`, podemos mutar
  // directamente.
  ref.value = ref.value + 1;
}

const c: Counter = new Counter(99);
increment(c);
print(numberToString(c.value));  // 100
