// Demo de template strings (interpolación): sintaxis `` `texto ${expr} texto` ``.
// Las expresiones se evalúan en su scope y se serializan vía `ets::concat` (que
// usa `operator<<` para que números/booleanos se conviertan automáticamente).

function greet(name: string, age: number): string {
  return `Hola ${name}, tienes ${age} años`;
}

function demo(): void {
  const name: string = "Mundo";
  const count: number = 42;
  const flag: boolean = true;

  // Mezcla de tipos primitivos.
  console.log(`Hola ${name}, count=${count}, flag=${flag}`);

  // Expresiones más complejas dentro del template.
  console.log(`Suma: ${count + 8}`);
  console.log(`Doble: ${count * 2}`);

  // Anidamiento: un template dentro de otro.
  const inner: string = `soy ${name}`;
  console.log(`Anidado: ${inner}`);

  // Función que retorna un template.
  console.log(greet("Ana", 30));

  // Template sin interpolación (parte literal pura).
  console.log(`Literal puro`);
}

demo();
