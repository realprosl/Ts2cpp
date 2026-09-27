// task-resolve — Issue #12: tareas que ya están completadas.
//
// El dialecto no expone `taskResolve<T>(v)` como built-in, pero un
// `async function` que retorna un literal sin suspenderse es
// semánticamente equivalente: el `Task<T>` produce su valor en cuanto
// se reanuda una vez. Aquí lo demostramos con tres sabores:
//
//   - `Promise<number>` con `return <expr>`.
//   - `Promise<string>` con `return <expr>`.
//   - `Promise<boolean>` calculado con `if/else`.
//
// Cada tarea se asigna a una variable, se le hace `await`, y se imprime
// el valor desempaquetado.

async function resolveNumber(): Promise<number> {
  return 7;
}

async function resolveString(): Promise<string> {
  return "hello";
}

async function resolveBool(flag: boolean): Promise<boolean> {
  if (flag) {
    return true;
  }
  return false;
}

const n: number = await resolveNumber();
const s: string = await resolveString();
const b: boolean = await resolveBool(true);
print(numberToString(n));
print(s);
print(numberToString(b ? 1 : 0));