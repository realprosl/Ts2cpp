// ============================================================================
// svg-with-discriminated-union.ets
//
// Codigo del usuario adaptado al dialecto Ts2cpp V30.13+ (despues de #185-#193).
// Usa:
//   - Interface SvgChild + Array<SvgChild> (V30.12.2 auto-union con clases).
//   - .push(value) para aniadir un elemento (V30.13).
//   - .length para leer el tamano (V30.13).
//   - .concat([v]) para concatenar arrays (V30.8 / V30.13).
//   - default_constructor() para std::variant default-constructible (V30.13).
//   - constructors con parametros + helper en_place_type (V30.13).
//
// Esperado: imprime "<line></line>" "<MultiLine></MultiLine>" "<line></line>"
// ============================================================================

class Line {
  kind: string
  constructor() { this.kind = "line" }
  build(): string { return "<line></line>" }
}

class MultiLine {
  kind: string
  currentx: i8
  currenty: i8
  constructor(currentx: i8, currenty: i8) {
    this.kind = "multiLine"
    this.currentx = currentx
    this.currenty = currenty
  }
  build(): string { return "<MultiLine></MultiLine>" }
}

interface SvgChild {
  kind: string
  build(): string
}

class Svg {
  children: Array<SvgChild>
  source: string
  constructor() {
    this.children = []
    this.source = "<svg>"
  }
  addChildren(children: Array<SvgChild>): void {
    for (let i: number = 0; i < children.length; i = i + 1) {
      this.children = this.children.concat([children[i]])
    }
  }
  build(): void {
    for (let i: number = 0; i < this.children.length; i = i + 1) {
      const child: SvgChild = this.children[i]
      print(child.build())
    }
  }
}

let svg: Svg = new Svg()
svg.addChildren([new Line(), new MultiLine(10, 20), new Line()])
svg.build()