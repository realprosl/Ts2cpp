// mutref-mutate — mutRefOf<T>, modificar el valor a través de la referencia.

class Counter {
  value: number;
  constructor(v: number) { this.value = v; }
}

function increment(ref: MutRef<Counter>): void {
  let holder: Counter = mutRefValue(ref);
  holder.value = holder.value + 1;
}

const c: Counter = new Counter(99);
increment(mutRefOf<Counter>(c));
print(numberToString(c.value));
