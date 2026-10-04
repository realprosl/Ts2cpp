// B4: match V2 destructurado exhaustivo sobre tagged union.
// Compara contra un switch sobre el `kind` en C++ nativo.
// NOTA: usamos 2 variantes con payload number para evitar el bug del
// checker V2 con payloads string (no narrowa a "clase concreta").

union Res = Ok(number) | Err(number);

function describe(r: Res): number {
  return match (r) {
    case { kind: "Ok", value }: value;
    case { kind: "Err", code }: 0.0 - code;
  };
}

let sum: number = 0;
for (let i: number = 0; i < 1000000; i = i + 1) {
  if (i % 3 == 0) {
    sum = sum + describe(Res.Ok(i));
  } else {
    sum = sum + describe(Res.Err(i));
  }
}
print(numberToString(sum));
