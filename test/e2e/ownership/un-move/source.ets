// un-move — Un<Counter>, mover entre scopes, unIsSome, unValue.

class Counter {
  value: number;

  constructor(v: number) {
    this.value = v;
  }
}

function take(): Un<Counter> {
  return unSome<Counter>(new Counter(42));
}

const owned: Un<Counter> = take();
if (unIsSome(owned)) {
  const c: Counter = unValue(owned);
  print(numberToString(c.value));
}
