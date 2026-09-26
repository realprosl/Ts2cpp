class Counter {
  value: number;
}

function inspect(counter: Counter): number {
  return counter.value;
}

function increment(mut counter: Counter): void {
  counter.value = counter.value + 1;
}

let counter: Counter = new Counter(41);
increment(counter);
print(inspect(counter));
