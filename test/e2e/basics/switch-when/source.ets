// switch-when — expresiones `match (subject) { when (pattern) => ... }`.
//
// El dialecto usa `match` (similar a TC39 stage 2) en lugar de `switch`/`case`.
// Cada arm se evalúa en orden; el primero que matchea determina el resultado.
// El último arm puede usar el wildcard `_` como default.

function classify(n: number): string {
  return match (n) {
    when (0) => "zero";
    when (1) => "one";
    when (2) => "two";
    when (3) => "three";
    when (_) => "many";
  };
}

print(classify(0));
print(classify(1));
print(classify(2));
print(classify(3));
print(classify(42));

// match como statement (descarta el valor con punto-y-coma al final).
function isWeekend(day: string): boolean {
  return match (day) {
    when ("sat") => true;
    when ("sun") => true;
    when (_) => false;
  };
}

print("sat = " + numberToString(isWeekend("sat") ? 1 : 0));
print("sun = " + numberToString(isWeekend("sun") ? 1 : 0));
print("mon = " + numberToString(isWeekend("mon") ? 1 : 0));
print("fri = " + numberToString(isWeekend("fri") ? 1 : 0));
