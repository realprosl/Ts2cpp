// Demo de function types explícitos: la anotación `(name: type) => result` puede
// declararse en variables y en parámetros. Aquí se verifica que la asignación
// de una closure coincidente con la firma pasa el type-checker y se traduce
// correctamente a `std::function<...>` en C++.

export let toUpper: (input: string) => string = (input: string) => {
  return input;
};

export function twice(action: (value: number) => string, base: number): string {
  return action(base) + "|" + action(base + 1);
}

export function demo(): void {
  console.log(toUpper("hola"));
  console.log(twice((value: number) => {
    return numberToString(value);
  }, 10));
}

demo();
