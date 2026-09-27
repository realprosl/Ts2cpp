// mut-of-lvalue — mutFrom<T>(lvalue), leer a través del puntero.

class Box {
  value: number;
  constructor(v: number) { this.value = v; }
}

const b: Box = new Box(50);
const m: Mut<Box> = mutFrom<Box>(b);
print(numberToString(mutValue(m).value));
