class Counter {
  private value: number;
  public label: string;
  private secret(): number { return this.value + 1; }
  constructor(initial: number) {
    this.value = initial;
    this.label = "contador";
  }
  public increment(): void {
    this.value = this.value + 1;
  }
  public describe(): string {
    return this.label;
  }
  public getValue(): number { return this.value; }
}

let c: Counter = new Counter(0);
c.increment();
c.increment();
print(c.describe());
print(c.getValue());
