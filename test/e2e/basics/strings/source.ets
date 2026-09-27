// strings — concatenación, longitud y comparación.
//
// El dialecto no soporta template literals con `${...}` en su forma básica;
// la composición se hace con `+` sobre operandos `string`/`number`.

const a: string = "hola";
const b: string = "mundo";

// Concatenación simple.
print(a + " " + b);

// Concatenación con número (numberToString necesario para imprimir, no para concatenar).
const n: number = 42;
print(a + " " + numberToString(n));

// Longitud (helper global `length`).
print("len(a) = " + numberToString(length(a)));
print("len(\"\") = " + numberToString(length("")));

// Igualdad y comparación.
const same: boolean = a == "hola";
const different: boolean = b == "adiós";
print("a == 'hola' = " + numberToString(same ? 1 : 0));
print("b == 'adiós' = " + numberToString(different ? 1 : 0));

// Strings en condicionales.
if (a == "hola") {
  print("saludo detectado");
} else {
  print("otro saludo");
}
