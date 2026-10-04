// B1: match por valor con 5 ramas (when + otherwise). Hot loop.
// Compara el IIFE del codegen V23 vs un if/else chain nativo en C++.

// Versión V23: if/else chain generado por el codegen.
function classify(n: number): string {
  return match(n, [
    when(0, (v: number): string => "zero"),
    when(1, (v: number): string => "one"),
    when(2, (v: number): string => "two"),
    when(3, (v: number): string => "three"),
    otherwise((): string => "many"),
  ]);
}

let sum: number = 0;
for (let i: number = 0; i < 1000000; i = i + 1) {
  const r: string = classify(i % 5);
  if (r == "zero") sum = sum + 1;
  else if (r == "one") sum = sum + 2;
  else if (r == "two") sum = sum + 3;
  else if (r == "three") sum = sum + 4;
  else sum = sum + 5;
}
print(numberToString(sum));
