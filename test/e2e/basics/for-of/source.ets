// for-of — iteración sobre arrays (y string) con `for (const x of iter)`.
//
// El tipo de la variable ligada se infiere a partir del iterable.

const numbers: number[] = [10, 20, 30, 40];
for (const x of numbers) {
  print("n = " + numberToString(x));
}

const words: string[] = ["alpha", "beta", "gamma"];
for (const w of words) {
  print("word = " + w);
}

// Acumulador sobre el array.
let total: number = 0;
for (const n of numbers) {
  total = total + n;
}
print("total = " + numberToString(total));

// Iteración sobre string (carácter por carácter).
const greeting: string = "hi";
for (const c of greeting) {
  print("char = " + c);
}

// For-of con `let` (binding mutable) sobre number[].
const nums: number[] = [1, 2, 3];
for (let n of nums) {
  n = n * 10;
  print("scaled = " + numberToString(n));
}
