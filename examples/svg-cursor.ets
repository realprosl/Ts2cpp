// V30.11.1: caso de regresión del bug de detección inter-procedimental de
// mutación. Esta es la forma ORIGINAL del archivo (antes del workaround que
// "sacaba el array de la clase"). Aquí `modX`/`modY` mutan `this` y `run`
// los llama, así que `run` debe ser no-const.
//
// Antes del fix V30.11.1, g++ daba:
//   error: passing 'const Svg' as 'this' argument discards qualifiers
//      in call to 'i8 Svg::modX(i8)'
// porque `methodMutates(run)` solo miraba si el cuerpo de run() asignaba
// directamente a `this.x`/`this.y`, no si llamaba a métodos de la misma
// clase que mutan. Tras V30.11.1, el análisis recursivo con visited set
// marca `run` como no-const y el código compila limpio.

class Svg {
  x: i8
  y: i8

  constructor() {
    this.x = 0
    this.y = 0
  }

  modX(dx: i8): i8 {
    this.x = this.x + dx
    return this.x
  }

  modY(dy: i8): i8 {
    this.y = this.y + dy
    return this.y
  }

  run(): void {
    for (let i: i8 = 0; i < 3; i = i + 1) {
      const nx: i8 = this.modX(10)
      const ny: i8 = this.modY(20)
      print("step=", i, "x=", nx, "y=", ny)
    }
  }
}

const s: Svg = new Svg()
s.run()