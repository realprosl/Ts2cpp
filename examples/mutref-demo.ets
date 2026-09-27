// mutref-demo.ets — `MutRef<T>` (alias mutable, equivalente a T& en C++).
//
// `MutRef<T>` representa una referencia mutable al objeto del caller. Se usa
// en parámetros de función para mutar in-place sin tomar ownership ni
// retornar. Se construye con `mutRefOf<T>(lvalue)` que toma la dirección.

class Counter {
  value: number;
  constructor(value: number) { this.value = value; }
}

function increment(ref: MutRef<Counter>): void {
  // El alias permite acceder al objeto subyacente. Para mutarlo, asignamos
  // a una variable NO-const.
  let holder: Counter = mutRefValue(ref);
  holder.value = holder.value + 1;
}

const c: Counter = new Counter(99);
increment(mutRefOf<Counter>(c));
print(numberToString(c.value));  // 100
