// spawn-await — Issue #12: `spawn(task)` para tareas fire-and-forget.
//
// El dialecto distingue dos formas de consumir un `Promise<T>`:
//
//   1. `await task`            — espera el resultado y lo devuelve.
//   2. `spawn(task)` (solo `Promise<void>`) — desconecta la tarea del
//      llamador; el event loop la ejecuta en background y los handles
//      "detached" se limpian cuando terminan.
//
// Aquí combinamos ambas: lanzamos un worker al event loop con `spawn` y,
// mientras tanto, esperamos una segunda tarea que produce el resultado
// final. Para que el worker detached termine antes de que salga el
// proceso, bombeamos el event loop unos cuantos ms.

async function worker(): Promise<void> {
  await sleep(1);
  print("worker done");
}

async function produce(): Promise<string> {
  await sleep(1);
  return "main result";
}

spawn(worker());

// Bombeamos el event loop para que el worker detached alcance su `print`.
async function pump(): Promise<void> {
  for (let i: number = 0; i < 5; i = i + 1) {
    await sleep(1);
  }
}

print(await produce());
await pump();