// value-copy — T significa copia: modificar el parámetro no afecta al caller.

class Box {
  value: number;
  constructor(v: number) { this.value = v; }
}

function mutate(b: Box): void {
  b.value = 999;
}

const original: Box = new Box(42);
mutate(original);
print(numberToString(original.value));
