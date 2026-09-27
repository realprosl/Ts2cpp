// rc-demo.ets — `Rc<T>` (smart pointer con conteo de referencias, equivalente
// a std::shared_ptr<T>).
//
// `Rc<T>` se construye con `rcShare<T>(value)`. Cada copia incrementa el
// contador; cuando llega a 0, el recurso se libera. Útil para grafos,
// caches, y estructuras donde varios owners legítimos comparten el mismo dato.

class Counter {
  value: number;
  constructor(value: number) { this.value = value; }
}

const a: Rc<Counter> = rcShare<Counter>(new Counter(10));
const b: Rc<Counter> = a;  // copia: contador sube
print(numberToString(rcStrongCount(a)));  // 2

const c: Rc<Counter> = rcShare<Counter>(new Counter(20));
print(numberToString(rcValue(c).value));  // 20
