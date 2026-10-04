// constref-read — constRef<T> permite leer pero el checker rechaza mutación.

class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) { this.x = x; this.y = y; }
}

function distance(p: constRef<Point>): number {
  return p.x * p.x + p.y * p.y;
}

const pt: Point = new Point(3, 4);
print(numberToString(distance(pt)));
