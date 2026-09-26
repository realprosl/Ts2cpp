function identity<T>(value: T): T {
  return value;
}

function first<T>(values: T[]): T {
  return values[0];
}

class Box<T> {
  value: T;

  get(): T {
    return this.value;
  }
}

const numberBox: Box<number> = new Box<number>(42);
const textBox: Box<string> = new Box<string>("generic");
const values: number[] = [10, 20, 30];

print("Identidad: ", identity("hola"));
print("Explícito: ", identity<number>(7));
print("Primero: ", first(values));
print("Caja number: ", numberBox.get());
print("Caja string: ", textBox.get());
