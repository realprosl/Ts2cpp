// ref-aliased — múltiples constRef<T> sobre el mismo valor son válidos.

class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) { this.x = x; this.y = y; }
}

function sum(p: constRef<Point>): number {
  return p.x + p.y;
}

const pt: Point = new Point(10, 20);
const a: number = sum(pt);
const b: number = sum(pt);
print(numberToString(a));
print(numberToString(b));
