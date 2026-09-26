// Demo de argumentos con valor por defecto: la sintaxis `function f(x: T = expr)`
// permite omitir el argumento en la llamada; el codegen lo emite como parámetro
// con default de C++ en la declaración y el type-checker lo valida con un scope
// que contiene los parámetros anteriores.

function greet(name: string, greeting: string = "Hola"): string {
  return greeting + ", " + name + "!";
}

function scale(value: number, factor: number = 2, offset: number = 100): number {
  return value * factor + offset;
}

function demo(): void {
  console.log(greet("Mundo"));
  console.log(greet("Ana", "Adiós"));
  console.log("scale 5:" + numberToString(scale(5)));
  console.log("scale 5,3:" + numberToString(scale(5, 3)));
  console.log("scale 5,3,1:" + numberToString(scale(5, 3, 1)));
}

demo();
