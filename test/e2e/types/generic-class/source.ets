// generic-class — clase genérica Box<T> con campo value y método get.

class Box<T> {
  value: T;

  constructor(v: T) {
    this.value = v;
  }

  get(): T {
    return this.value;
  }
}

const nb: Box<number> = new Box<number>(123);
const sb: Box<string> = new Box<string>("hi");

print(numberToString(nb.get()));
print(sb.get());
