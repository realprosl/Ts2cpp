// switch-when — V23: match intrinsics con sintaxis compatible con TypeScript.
//
// `match(value, [when(pattern, callback), ...])` desazucara a un
// if/else chain (IIFE) que se compila a codigo C++ nativo. El ultimo
// arm puede usar `otherwise(callback)` como default (antes era `when (_)`
// con wildcard).

function classify(n: number): string {
  return match(n, [
    when(0, (v: number): string => "zero"),
    when(1, (v: number): string => "one"),
    when(2, (v: number): string => "two"),
    when(3, (v: number): string => "three"),
    otherwise((): string => "many"),
  ]);
}

print(classify(0));
print(classify(1));
print(classify(2));
print(classify(3));
print(classify(42));

// match como expression (su valor se devuelve directamente).
function isWeekend(day: string): boolean {
  return match(day, [
    when("sat", (d: string): boolean => true),
    when("sun", (d: string): boolean => true),
    otherwise((): boolean => false),
  ]);
}

print("sat = " + numberToString(isWeekend("sat") ? 1 : 0));
print("sun = " + numberToString(isWeekend("sun") ? 1 : 0));
print("mon = " + numberToString(isWeekend("mon") ? 1 : 0));
print("fri = " + numberToString(isWeekend("fri") ? 1 : 0));
