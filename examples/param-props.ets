class Point {
  constructor(readonly x: number, readonly y: number, private label: string) {
  }
  describe(): string {
    return this.label;
  }
  getLabel(): string { return this.label; }
  getX(): number { return this.x; }
  getY(): number { return this.y; }
}

let p: Point = new Point(3, 4, "origen");
print(p.describe());
print(p.getX());
print(p.getY());
print(p.getLabel());
