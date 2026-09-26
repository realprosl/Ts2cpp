// Demostración de `enum`: numéricos con auto-incremento y valores explícitos,
// y de cadena con valores explícitos.
enum Color { Red, Green = 5, Blue }
enum Direction { Up = "UP", Down = "DOWN", Left = "LEFT", Right = "RIGHT" }

let c: Color = Color.Green;
print(numberToString(c));

let d: Direction = Direction.Up;
print(d);

let all: Direction[] = [Direction.Up, Direction.Down, Direction.Left, Direction.Right];
for (const v of all) print(v);
