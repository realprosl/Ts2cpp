// V5 — Readonly profundo: tipos inmutables.
// Sintaxis: `readonly <Tipo>` como decoración. Codegen traduce a `const T&`.
// Validación: el checker rechaza mutaciones sobre valores readonly.

function showScalar(x: readonly number): void {
  print("x =", x);
}

function showVector(xs: readonly number[]): void {
  print("xs[0] =", xs[0]);
  print("xs[1] =", xs[1]);
}

function showFixed(buf: readonly u8[3]): void {
  print("buf[0] =", buf[0]);
  print("buf[2] =", buf[2]);
}

showScalar(42);

let arr: number[] = [10, 20, 30];
showVector(arr);

let buf: u8[3] = [1, 2, 3];
showFixed(buf);