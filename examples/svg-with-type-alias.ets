// ============================================================================
// svg-with-type-alias.ets
//
// Ejemplo que demuestra:
// - type alias para discriminated unions (V30.14.1)
// - Array<type-alias> se traduce a std::vector<std::variant<...>>
// - Mismo comportamiento que con interface+auto-union, pero con sintaxis
//   mas natural (no requiere declarar interface vacia)
//
// Antes de V30.14.1, este ejemplo fallaba con:
//   error: 'SvgChild' was not declared in this scope
//   (el field se emitia como std::vector<SvgChild> en vez de std::variant<...>)
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

// V30.14.1: type alias para union de clases. Mas natural que
// declarar una interface con `kind: string` por cada union.
type SvgChild = Line | Circle

class Svg {
  children: Array<SvgChild>
  constructor() { this.children = [] }
  add(child: SvgChild): void { this.children.push(child) }
}

let svg: Svg = new Svg()
svg.add(new Line())
svg.add(new Circle())
svg.add(new Line())
print(svg.children.length)  // 3
// (No podemos llamar svg.children[i].build() directamente porque el
// type-checker no infiere metodos en union types. Eso se arregla en
// el PR V30.14.2 (match con discriminator).)
// Output esperado:
//   3
