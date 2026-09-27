// task-all-numbers — Issue #12: `all([t1, t2])` con `Promise<number>`.
//
// `all` espera a todas las tareas y devuelve `number[]`. Aquí sumamos los
// dos valores resultantes.

async function delay(ms: number, value: number): Promise<number> {
  await sleep(ms);
  return value;
}

async function sumTwo(): Promise<number> {
  const tasks: Promise<number>[] = [delay(1, 10), delay(1, 32)];
  const results: number[] = all(tasks);
  return results[0] + results[1];
}

print(numberToString(await sumTwo()));