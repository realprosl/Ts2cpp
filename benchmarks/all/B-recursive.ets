// B-recursive: recursion simple (factorial). Mide el coste del call
// frame del dialecto (que pasa argumentos por valor y retorna por valor).

function factorial(n: number): number {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

let acc: number = 0;
for (let i: number = 1; i <= 12; i = i + 1) {
  acc = acc + factorial(i);
}

print(numberToString(acc));
