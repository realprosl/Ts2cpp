// task-all-strings — Issue #12: `all([t1, t2, t3])` con `Promise<string>`.
//
// `all` espera a todas las tareas del array y devuelve un vector con los
// resultados en el mismo orden. Aquí lo usamos sobre `Promise<string>`
// para producir y luego concatenar los strings resultantes.

async function delayStr(ms: number, value: string): Promise<string> {
  await sleep(ms);
  return value;
}

async function collectStrings(): Promise<string> {
  const parts: Promise<string>[] = [
    delayStr(1, "alpha"),
    delayStr(1, "beta"),
    delayStr(1, "gamma")
  ];
  const results: string[] = all(parts);
  let acc: string = "";
  for (const s of results) {
    acc = acc + s + " ";
  }
  return acc;
}

print(await collectStrings());