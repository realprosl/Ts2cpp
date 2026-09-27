// mut-demo.ets — `Mut<T>` (puntero mutable no-owning).
//
// `Mut<T>` se usa como tipo de parámetro para indicar que la función puede
// mutar el objeto apuntado. El codegen lo traduce a `T*` y obtiene la
// dirección automáticamente cuando se pasa un lvalue.
//
// En C++:
//   function bump(p: Mut<Counter>): void  →  void bump(Counter* p)
//   bump(c)                                →  bump(&c)

class Counter {
  value: number;
  constructor(value: number) { this.value = value; }
}

function bump(p: Mut<Counter>): void {
  // Como `p: Mut<Counter>` se traduce a `Counter* p`, podemos mutar
  // directamente a través del puntero.
  p.value = p.value + 1;
  print(numberToString(p.value));
}

const c: Counter = new Counter(7);
bump(c);
print(numberToString(c.value));  // 8 (mutado a través del puntero)
