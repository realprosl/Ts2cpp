// B-closures: closure capturando estado por referencia. Mide el
// coste del IIFE + captura del dialecto.
//
// Patrón: acumulamos en un array usando un closure. Cada closure
// captura el array por referencia y suma 1 al elemento i.
//
// NOTA: en este patron el array vive en el scope del for-loop, no se
// retorna nada desde dentro del closure, asi que NO es UB.

let acc: number = 0;
for (let i: number = 0; i < 1000; i = i + 1) {
  let counts: number[] = [];
  for (let k: number = 0; k < 100; k = k + 1) {
    counts.push(0);
  }
  // Capturamos `counts` por referencia
  const increment: (idx: number) => void = (idx: number): void => {
    counts[idx] = counts[idx] + 1;
  };
  for (let j: number = 0; j < 1000; j = j + 1) {
    increment(j % 100);
  }
  for (let k: number = 0; k < 100; k = k + 1) {
    acc = acc + counts[k];
  }
}

print(numberToString(acc));
