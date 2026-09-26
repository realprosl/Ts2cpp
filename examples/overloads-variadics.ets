function describe(value: number): string {
  return "number=" + numberToString(value);
}

function describe(value: string): string {
  return "string=" + value;
}

function describe<T>(value: T): string {
  return "generic";
}

function logAll<...T>(...values: T): void {
  print(values);
}

print(describe(42.0));
print(describe("hello"));
print(describe(true));
logAll("mixed: ", 10, ", ", true);
logAll<number, string>(7, " explicit");
