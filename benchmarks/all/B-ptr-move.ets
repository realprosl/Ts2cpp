// B-ptr-move: V22 memory model. Crea ptr<T>, los mueve, los usa.
// Mide el coste de unique_ptr + move semantics del runtime.

class Box {
  value: number;
  constructor(v: number) { this.value = v; }
}

function makeBox(v: number): ptr<Box> {
  return new Box(v);
}

let acc: number = 0;
for (let i: number = 0; i < 100000; i = i + 1) {
  let b: ptr<Box> = makeBox(i);
  // Mover a otra variable (V22 move semantics)
  let b2: ptr<Box> = move(b);
  acc = acc + b2.value;
}

print(numberToString(acc));
