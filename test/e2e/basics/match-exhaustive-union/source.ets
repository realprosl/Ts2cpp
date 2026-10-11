// exhaustive-union: V30 con V23 intrinsics.
// V30 elimino la forma V2 (`match (r) { case { kind: "Success", s }: ...; }`).
// Ahora se usa `match(r, [when(pat, cb), ...])` (sin discriminator) o
// `whenType<T>(cb)` (con narrowing via std::holds_alternative).
//
// Este test verifica la forma V23 sin union: dispatch por valor sobre
// `string | number`. Es la unica forma V23 que compila out-of-the-box.
// La forma con discriminator sobre tagged unions es un bug pre-existente
// del codegen (V23 con discriminator no convierte el pattern a enum).

function describeNumber(n: number): string {
  return match(n, [
    when(0, (v: number): string => "zero"),
    when(1, (v: number): string => "one"),
    otherwise((): string => "many"),
  ]);
}

print(describeNumber(0));
print(describeNumber(1));
print(describeNumber(42));
