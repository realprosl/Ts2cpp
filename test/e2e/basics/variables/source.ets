// variables — const vs let, shadowing en bloques.
//
// `const` produce inmutables; `let` permite reasignación. Las variables
// declaradas dentro de un bloque `{}` sombrean a las del scope externo
// sin afectar el valor exterior.

const name: string = "outside";
print("name inicial = " + name);

// Reasignación con `let`.
let counter: number = 0;
print("counter inicial = " + numberToString(counter));
counter = counter + 1;
counter = counter + 5;
print("counter final = " + numberToString(counter));

// Shadowing dentro de un bloque.
{
  const name: string = "inside";
  let counter: number = 100;
  print("name en bloque = " + name);
  print("counter en bloque = " + numberToString(counter));
}

print("name fuera = " + name);
print("counter fuera = " + numberToString(counter));

// Tipos inferidos a partir del initializer (sin anotación explícita).
const inferredStr = "inferred";
const inferredNum = 42;
print("inferredStr = " + inferredStr);
print("inferredNum = " + numberToString(inferredNum));
