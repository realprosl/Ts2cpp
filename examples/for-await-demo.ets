// for-await-demo.ets — Fase 1.8: `for await (const x of iterable)`.
//
// `for await` permite iterar secuencialmente sobre un array de promesas y
// desempaquetar cada elemento con `await`. Es syntactic sugar sobre
// `for (const __p of arr) { const x = await __p; ... }`.
//
// Restricción actual: el iterable debe ser `Promise<T>[]`. La variable de
// iteración queda como `T`. Se ejecuta en orden secuencial (cada elemento
// espera al anterior).

async function delay(ms: number, value: number): Promise<number> {
  await sleep(ms);
  return value;
}

// Función que demuestra `for await` sobre un array de promesas.
async function collectInOrder(): Promise<string> {
  const promises: Promise<number>[] = [delay(5, 100), delay(5, 200), delay(5, 300)];
  let acc: string = "";
  for await (const v of promises) {
    acc = acc + numberToString(v) + " ";
  }
  return acc;
}

// Función que demuestra la semántica secuencial: cada `await` espera al anterior.
async function sumInOrder(): Promise<number> {
  const promises: Promise<number>[] = [delay(10, 1), delay(10, 2), delay(10, 3)];
  let acc: number = 0;
  for await (const v of promises) {
    acc = acc + v;
  }
  return acc;
}

// Caso iterable vacío: el cuerpo no se ejecuta.
async function empty(): Promise<string> {
  const promises: Promise<number>[] = [];
  let acc: string = "done";
  for await (const v of promises) {
    acc = numberToString(v);
  }
  return acc;
}

print(await collectInOrder());  // 100 200 300
print(numberToString(await sumInOrder()));  // 6
print(await empty());  // done
