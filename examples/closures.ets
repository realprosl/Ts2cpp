function makeAdder(amount: number): (value: number) => number {
  return (value: number): number => value + amount;
}

function makeCounter(start: number): () => number {
  let count: number = start;
  return (): number => {
    count = count + 1;
    return count;
  };
}

const timesTwo: (value: number) => number = (value: number): number => value * 2;
const addTen: (value: number) => number = makeAdder(10);
const counter: () => number = makeCounter(100);

print("Doble: ", timesTwo(6));
print("Suma capturada: ", addTen(5));
print("Contador: ", counter());
print("Contador: ", counter());
