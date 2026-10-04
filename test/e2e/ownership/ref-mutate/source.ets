// ref-mutate — ref<Counter> permite mutar el valor a través de la referencia.
// V22 §3: T puede prestarse como ref<T> o constRef<T> cuando es un lvalue.

class Counter {
  value: number;
  constructor(v: number) { this.value = v; }
}

function increment(c: ref<Counter>): void {
  c.value = c.value + 1;
}

const counter: Counter = new Counter(99);
increment(counter);
print(numberToString(counter.value));
