// B-for-of: iteracion basica sobre un array. Mide el coste del for..of
// vs un for indexado en C++.

function sumArray(arr: number[]): number {
  let s: number = 0;
  for (const x of arr) {
    s = s + x;
  }
  return s;
}

let total: number = 0;
for (let i: number = 0; i < 1000; i = i + 1) {
  let arr: number[] = [];
  for (let j: number = 0; j < 10000; j = j + 1) {
    arr.push(j);
  }
  total = total + sumArray(arr);
}

print(numberToString(total));
