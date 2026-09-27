// un-as-parameter — pasar Un<T> por función, leer valor.

class Wrap {
  value: number;
  constructor(v: number) { this.value = v; }
}

function readValue(u: Un<Wrap>): number {
  if (unIsSome(u)) {
    const w: Wrap = unValue(u);
    return w.value;
  }
  return -1;
}

const owned: Un<Wrap> = unSome<Wrap>(new Wrap(123));
print(numberToString(readValue(owned)));
