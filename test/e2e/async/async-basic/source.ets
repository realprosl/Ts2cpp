// async-basic — Issue #12: fundamentos de `async`/`await`.
//
// Verifica que el dialecto compila y ejecuta el patrón más simple:
//   - declarar `async function` con `Promise<T>` como tipo de retorno
//   - esperar el resultado con `await`
//   - retornar un valor desde una corutina
//
// Equivale al smoke test E2E del bucket `async`: si esto no pasa, ningún
// otro test de la familia tiene sentido.

async function loadValue(): Promise<number> {
  return 21;
}

async function compute(): Promise<number> {
  const value: number = await loadValue();
  return value * 2;
}

async function greet(): Promise<string> {
  return "async-basic ok";
}

const result: number = await compute();
print(numberToString(result));
print(await greet());