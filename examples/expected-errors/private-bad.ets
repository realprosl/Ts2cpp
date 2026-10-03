class Counter {
  private value: number;
  public label: string;
  private secret(): number { return this.value + 1; }
  constructor(initial: number) {
    this.value = initial;
    this.label = "contador";
  }
}

let c: Counter = new Counter(0);
print(c.value);
