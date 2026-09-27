// class-basic — clase simple con campo `number`, `new`, y método.
//
// Sin herencia (no soportada en el dialecto). Los campos se declaran
// directamente en el cuerpo; `new ClassName(args)` inicializa aggregate.

class Box {
  value: number;

  describe(): string {
    return "Box(" + numberToString(this.value) + ")";
  }

  increment(): void {
    this.value = this.value + 1;
  }
}

let b: Box = new Box(42);
print(b.describe());
print("value inicial = " + numberToString(b.value));
b.increment();
b.increment();
print("tras 2 increment = " + numberToString(b.value));

// Clase con varios campos y método que combina.
class Rect {
  width: number;
  height: number;

  area(): number {
    return this.width * this.height;
  }
}

const r: Rect = new Rect(3, 4);
print("area(3x4) = " + numberToString(r.area()));
print("width = " + numberToString(r.width));
print("height = " + numberToString(r.height));

// Clase vacía.
class Empty {}
const e: Empty = new Empty();
print("Empty ok");
