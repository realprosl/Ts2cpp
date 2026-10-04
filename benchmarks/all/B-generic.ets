// B-generic: clase generica Box<T> con metodos. Mide el coste de
// la instanciacion del template.

class Box<T> {
  value: T;
  constructor(v: T) { this.value = v; }
}

let acc: number = 0;
for (let i: number = 0; i < 100000; i = i + 1) {
  let b: Box<number> = new Box<number>(i);
  b.value = i + 1;
  acc = acc + b.value;
}

print(numberToString(acc));
