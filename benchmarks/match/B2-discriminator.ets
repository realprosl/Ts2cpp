// B2: match con discriminator de string (forma `match(v, "kind", [...])`).
// Compara contra un if/else chain sobre `v.kind` en C++ nativo.

class Shape {
  kind: string;
  area: number;
  constructor(k: string, a: number) {
    this.kind = k;
    this.area = a;
  }
}

function areaKind(s: Shape): string {
  return match(s, "kind", [
    when("circle",   (x: Shape): string => "circle:"   + numberToString(x.area)),
    when("square",   (x: Shape): string => "square:"   + numberToString(x.area)),
    when("triangle", (x: Shape): string => "triangle:" + numberToString(x.area)),
    when("hexagon",  (x: Shape): string => "hexagon:"  + numberToString(x.area)),
    otherwise((x: Shape): string => "other:" + numberToString(x.area)),
  ]);
}

let sum: number = 0;
for (let i: number = 0; i < 1000000; i = i + 1) {
  const k: string = i % 5 == 0 ? "circle" : i % 5 == 1 ? "square" : i % 5 == 2 ? "triangle" : i % 5 == 3 ? "hexagon" : "other";
  const s: Shape = new Shape(k, 1.0);
  const r: string = areaKind(s);
  if (r == "circle:1") sum = sum + 1;
  else if (r == "square:1") sum = sum + 2;
  else if (r == "triangle:1") sum = sum + 3;
  else if (r == "hexagon:1") sum = sum + 4;
  else sum = sum + 5;
}
print(numberToString(sum));
