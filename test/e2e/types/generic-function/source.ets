// generic-function — función genérica con inferencia de tipo.

function identity<T>(x: T): T {
  return x;
}

const n: number = identity<number>(42);
const s: string = identity<string>("hello");

print(numberToString(n));
print(s);
