// Demo de intersection types: el parámetro genérico debe satisfacer
// múltiples interfaces simultáneamente (`T extends Named & Aged`).

interface Named {
  name(): string;
}

interface Aged {
  age(): number;
}

class Person {
  name(): string { return "Alice"; }
  age(): number { return 30; }
}

class Robot {
  name(): string { return "R2D2"; }
  age(): number { return 5; }
}

function describe<T extends Named & Aged>(value: T): string {
  return value.name() + " (" + numberToString(value.age()) + ")";
}

console.log(describe(new Person()));
console.log(describe(new Robot()));
