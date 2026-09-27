// booleans — operadores lógicos, comparación y control de flujo.
//
// `&&`, `||`, `!`, y las comparaciones `<`, `>`, `<=`, `>=`, `==`, `!=`
// producen `boolean`. Se imprime con número 1/0 vía `numberToString`.

const a: boolean = true;
const b: boolean = false;

print("a && b = " + numberToString(a && b ? 1 : 0));
print("a || b = " + numberToString(a || b ? 1 : 0));
print("!a     = " + numberToString(!a ? 1 : 0));
print("!b     = " + numberToString(!b ? 1 : 0));

// Combinaciones con cortocircuito.
print("a && true = " + numberToString((a && true) ? 1 : 0));
print("b || true = " + numberToString((b || true) ? 1 : 0));

// Comparación numérica.
const x: number = 10;
const y: number = 20;
print("x < y  = " + numberToString(x < y ? 1 : 0));
print("x > y  = " + numberToString(x > y ? 1 : 0));
print("x <= y = " + numberToString(x <= y ? 1 : 0));
print("x >= y = " + numberToString(x >= y ? 1 : 0));
print("x == y = " + numberToString(x == y ? 1 : 0));
print("x != y = " + numberToString(x != y ? 1 : 0));
print("x == 10 = " + numberToString(x == 10 ? 1 : 0));

// Boolean como condicional.
if (a) {
  print("a es true");
}
if (!b) {
  print("b es false");
}
