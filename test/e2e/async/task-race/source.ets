// task-race — Issue #12: `race([t1, t2])` (limitación: secuencial).
//
// LIMITACIÓN CONOCIDA: el runtime no tiene un event loop que respete
// cancelaciones parciales, así que `race` está implementado como
// `syncWait(tasks.front())`. Es decir, devuelve **el primer elemento del
// array**, no el que termine antes en paralelo.
//
// El test verifica exactamente ese comportamiento: el primer elemento es
// el que gana, sin importar su `delay`.

async function delay(ms: number, value: number): Promise<number> {
  await sleep(ms);
  return value;
}

async function firstWins(): Promise<number> {
  // `delay(100, 1)` es "más lento" pero va primero en el array: debe ganar.
  return race([delay(100, 1), delay(1, 999)]);
}

print(numberToString(await firstWins()));