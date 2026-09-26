class Box<T = number> {
  value: T;
}

function makeNum<T = number>(v: T): T { return v; }

let b = new Box<number>(7);
print(numberToString(b.value));

print(numberToString(makeNum<number>(42)));
print(numberToString(makeNum(99)));
