function factorial(n: number): number {
  let result: number = 1;
  let i: number = 2;
  while (i <= n) {
    result = result * i;
    i = i + 1;
  }
  return result;
}

const name: string = "mundo";
const value = factorial(5);
print("Hola, " + name);
print(value);
