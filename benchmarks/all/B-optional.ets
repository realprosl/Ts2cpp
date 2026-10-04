// B-optional: V14 Optional<T>. Mide el coste de optionalSome/optionalNone
// + valueOr() en un loop.

let acc: number = 0;
for (let i: number = 0; i < 1000000; i = i + 1) {
  const opt: Optional<number> = optionalSome<number>(i);
  acc = acc + opt.valueOr(-1);
}

print(numberToString(acc));
