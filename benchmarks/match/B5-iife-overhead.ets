// B5: overhead puro del IIFE. Una funcion trivial `trivial` con un
// match de 1 sola rama (always-match) sobre un valor. Medimos el
// coste de la captura lambda + dispatch vs una funcion inline en C++.

function trivial(n: number): number {
  return match(n, [
    when(0, (v: number): number => v + 1),
    otherwise((v: number): number => v),
  ]);
}

let sum: number = 0;
for (let i: number = 0; i < 5000000; i = i + 1) {
  sum = sum + trivial(i);
}
print(numberToString(sum));
