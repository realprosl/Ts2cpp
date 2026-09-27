// arithmetic — operaciones aritméticas básicas con numberToString.
//
// Cubre +, -, *, /, % sobre `number`. Todos los resultados se imprimen
// vía `numberToString(x)` para evitar conversiones implícitas.

const a: number = 10;
const b: number = 3;

print("a + b = " + numberToString(a + b));
print("a - b = " + numberToString(a - b));
print("a * b = " + numberToString(a * b));
print("a / b = " + numberToString(a / b));
print("a % b = " + numberToString(a % b));

// Precedencia y paréntesis.
print("a + b * 2 = " + numberToString(a + b * 2));
print("(a + b) * 2 = " + numberToString((a + b) * 2));

// Negativos y combinación.
const c: number = -5;
print("c + a = " + numberToString(c + a));
print("a - c = " + numberToString(a - c));
