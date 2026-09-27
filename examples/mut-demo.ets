// mut-demo.ets — `Mut<T>` (puntero mutable no-owning, equivalente a T* const
// en C++).
//
// `Mut<T>` es la opción "unsafe" estilo C: puntero crudo que no toma ownership.
// Por convención del dialecto, el PUNTERO es constante (no se puede reasignar)
// pero el CONTENIDO apuntado es mutable. Se construye con `mutFrom<T>(lvalue)`.

class Counter {
  value: number;
  constructor(value: number) { this.value = value; }
}

function bump(p: Mut<Counter>): void {
  // `mutValue` devuelve T& (mutable).
  const local: Counter = mutValue(p);
  print(numberToString(local.value));
  // mutIsSome comprueba si el puntero no es nullptr.
  print(mutIsSome(p) ? "1" : "0");
}

const c: Counter = new Counter(7);
bump(mutFrom<Counter>(c));
print(numberToString(c.value));  // 7 (no mutamos aquí, solo leemos)
