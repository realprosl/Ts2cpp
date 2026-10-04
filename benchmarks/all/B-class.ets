// B-class: clase con constructor + métodos. Mide el coste de instanciar
// 100k objetos y llamar a un método sobre cada uno.

class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  sum(): number { return this.x + this.y; }
  scale(k: number): number { return this.x * k + this.y * k; }
}

function makePoint(i: number): Point {
  return new Point(i, i * 2);
}

let acc: number = 0;
for (let i: number = 0; i < 100000; i = i + 1) {
  const p: Point = makePoint(i);
  acc = acc + p.sum() + p.scale(0.5);
}

print(numberToString(acc));
