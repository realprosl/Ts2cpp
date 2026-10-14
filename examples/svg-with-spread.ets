// ============================================================================
// svg-with-spread.ets
//
// Ejemplo que demuestra:
// - Array<Interface> con auto-union (V30.12.2)
// - ...spread en array literal (V30.13.4)
// - .push, .pop, .length en arrays (V30.13.2)
// - metodo de clase que muta this via push (V30.13.4: deteccion inter-procedimental)
//
// V30.13.4 fija 4 bugs pre-existentes del codegen:
//   1. Interface sin metodos emitia concept vacio (g++ falla con requires vacio)
//   2. template <I T0> en vez de template <typename T0> requires I<T0>
//   3. Interface privada no se emitia en el header (forward del metodo fallaba)
//   4. Lambdas para spread no capturaban this ni parametros del metodo
// ============================================================================

class Line {
  kind: string
  points: number
  constructor() { this.kind = "line"; this.points = 2 }
  build(): string { return "<line/>" }
}

class Circle {
  kind: string
  radius: number
  constructor() { this.kind = "circle"; this.radius = 5 }
  build(): string { return "<circle/>" }
}

interface SvgChild {
  kind: string
  build(): string
}

class Svg {
  children: Array<SvgChild>
  source: string
  constructor() { this.children = []; this.source = "" }
  add(child: SvgChild): void { this.children.push(child) }
  addAll(more: Array<SvgChild>): void {
    // ...spread en array literal (V30.13.4: captura this + param 'more')
    this.children = [...this.children, ...more]
  }
  concat(): string {
    // V30.13.4: deteccion inter-procedimental de mutacion en sub-objetos.
    // Este metodo muta this.source desde un forEach, asi que NO debe
    // ser const.
    this.source = ""
    let i: number = 0
    while (i < this.children.length) {
      this.source = this.source + this.children[i].build()
      i = i + 1
    }
    return this.source
  }
}

let svg: Svg = new Svg()
svg.add(new Line())
svg.add(new Circle())
svg.addAll([new Line(), new Circle()])
print(svg.children.length)  // 4
svg.children.pop()
print(svg.children.length)  // 3
print(svg.concat())         // <line/><circle/><line/>

