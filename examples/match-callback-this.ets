// V30.12.1: Verifica que los callbacks de `match` dentro de métodos de clase
// pueden llamar a métodos no-const de `this` aunque el método exterior sea
// marcado `const` por el codegen.
//
// Antes del fix, el callback se emitía con `[=, this]` (captura por valor de
// `this`), lo que producía un `this` const si el método exterior era const.
// Llamadas a `this.modX()` desde el callback fallaban con:
//   passing const Svg as \'this\' argument discards qualifiers
//
// Después del fix, el callback usa `[&, this]` (captura por referencia) y
// las mutaciones a través de métodos no-const de `this` funcionan.

class Mod { kind: string; x: i8; y: i8; constructor(k: string, xv: i8, yv: i8) { this.kind = k; this.x = xv; this.y = yv } }

class Svg {
  x: i8
  y: i8
  mods: Mod[]
  constructor(mods: Mod[]) { this.mods = mods; this.x = 0; this.y = 0 }
  modX(x: i8): i8 { this.x = this.x + x; return this.x }
  modY(y: i8): i8 { this.y = this.y + y; return this.y }
  apply(m: Mod): void {
    match(m, "kind", [
      when("drawLine", (x: Mod): void => print(`drawLine x: ${this.modX(x.x)} y: ${this.modY(x.y)}`)),
      when("moveCursor", (x: Mod): void => print(`moveCursor x: ${this.modX(x.x)} y: ${this.modY(x.y)}`)),
    ])
  }
  run(): void {
    for (let i: number = 0; i < this.mods.length; i = i + 1) this.apply(this.mods[i])
  }
}

const s = new Svg([
  new Mod("drawLine", 10, 20),
  new Mod("moveCursor", 5, 7),
])
s.run()
