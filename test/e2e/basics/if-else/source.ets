// if-else — ramas básicas y condición compuesta.

function describe(n: number): void {
  if (n == 0) {
    print("zero");
  } else if (n == 1) {
    print("one");
  } else if (n == 2) {
    print("two");
  } else {
    print("many");
  }
}

describe(0);
describe(1);
describe(2);
describe(7);

// Condición compuesta con && y ||.
function range(n: number): void {
  if (n >= 1 && n <= 10) {
    print("small");
  } else if (n > 10 || n < 0) {
    print("out of range");
  } else {
    print("zero");
  }
}

range(5);
range(50);
range(-3);
range(0);

// Negación combinada.
const fine: boolean = true;
const ready: boolean = false;
if (fine && !ready) {
  print("fine pero no ready");
}
if (fine || ready) {
  print("fine o ready");
}
