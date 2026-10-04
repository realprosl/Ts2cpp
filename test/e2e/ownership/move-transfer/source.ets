// move-transfer — `move(p)` transfiere la ownership de un `ptr<T>`.
// El codegen emite `std::move(p)` y `p` queda en estado Moved, por lo
// que el checker rechaza cualquier uso posterior (E4102). El receptor
// recibe un `ptr<T>` válido y los accesos a sus miembros usan `->`.
// V22 (Memory Model v2) §PR#5: move() y tracking de estados.

class Counter {
  value: number;
  constructor(v: number) { this.value = v; }
}

function inspect(p: ptr<Counter>): void {
  print(numberToString(p.value));
}

const a: ptr<Counter> = new Counter(11);
const b: ptr<Counter> = move(a);
inspect(move(b));