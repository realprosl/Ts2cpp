// mutable-borrows.ets — V22: `ref<T>` permite mutar el valor del caller.
// Antes de V22, este ejemplo usaba `mut counter: Counter`.

class Counter {
  value: number;
  constructor(v: number) { this.value = v; }
}

function inspect(counter: constRef<Counter>): number {
  return counter.value;
}

function increment(counter: ref<Counter>): void {
  // ref<Counter> es T&: el callee muta el valor del caller.
  counter.value = counter.value + 1;
}

let counter: Counter = new Counter(41);
increment(counter);
print(numberToString(inspect(counter)));
