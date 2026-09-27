// union-narrowing — uso de tipos unión y typeof.

function isString(value: number | string): boolean {
  return typeof value == "string";
}

function describe(value: number | string): string {
  return "isString=" + numberToString(typeof value == "string" ? 1 : 0);
}

print(numberToString(isString(42) ? 1 : 0));
print(numberToString(isString("hello") ? 1 : 0));
print(describe(42));
print(describe("hello"));
