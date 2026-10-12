// V30.8: `forEach` aplica un callback a cada elemento. No devuelve nada.
let sum: number = 0;
[1, 2, 3, 4].forEach((n: number): void => { sum = sum + n; });
print(numberToString(sum));   // 10
