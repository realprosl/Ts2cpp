// B-array-ops: pipeline de arrays (filter + map + reduce).
// Mide el coste del wrapper de arrays del runtime y los lambdas.

function sumOfSquaresOfEvens(): number {
  let arr: number[] = [];
  for (let i: number = 0; i < 1000; i = i + 1) {
    arr.push(i);
  }
  const evens: number[] = arr.filter((x: number): boolean => x % 2 == 0);
  const squares: number[] = evens.map((x: number): number => x * x);
  return squares.reduce<number>(0, (acc: number, x: number): number => acc + x);
}

let total: number = 0;
for (let i: number = 0; i < 100; i = i + 1) {
  total = total + sumOfSquaresOfEvens();
}

print(numberToString(total));
