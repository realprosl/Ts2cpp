// promise-all-race-demo.ets — Fase 1.13: `all(tasks)` y `race(tasks)`.
//
// El dialecto expone dos helpers sobre arrays de Promise<T> (Task<T>[] en
// C++):
// - `all(tasks)`: espera a que todas las tareas terminen y devuelve T[].
// - `race(tasks)`: espera a la primera tarea y devuelve T (el resto se
//   descarta; limitación: con syncWait devuelve la primera del array,
//   no la más rápida en paralelo).

async function delay(ms: number, value: number): Promise<number> {
  await sleep(ms);
  return value;
}

async function runAll(): Promise<number[]> {
  // `all` espera secuencialmente a cada tarea y devuelve un vector con
  // los resultados en orden.
  return all([delay(1, 10), delay(1, 20), delay(1, 30)]);
}

async function runRace(): Promise<number> {
  // `race` toma el primer elemento (con syncWait; para paralelismo real
  // haría falta un event loop con callbacks).
  return race([delay(100, 1), delay(100, 2), delay(100, 3)]);
}

async function delayStr(ms: number, value: string): Promise<string> {
  await sleep(ms);
  return value;
}

async function runAllStrings(): Promise<string[]> {
  return all([delayStr(1, "alpha"), delayStr(1, "beta"), delayStr(1, "gamma")]);
}

// Demo 1: `all` con numbers.
const numbers: number[] = await runAll();
for (const n of numbers) print(numberToString(n));

// Demo 2: `race` con numbers (devuelve el primero del array).
const first: number = await runRace();
print(numberToString(first));

// Demo 3: `all` con strings.
const letters: string[] = await runAllStrings();
for (const s of letters) print(s);
