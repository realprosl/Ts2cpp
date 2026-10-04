// ptr-from-new — el codegen infiere std::make_unique<T>(...) cuando
// se inicializa un `ptr<T>` con `new T(...)` directamente. El acceso
// a miembros vía `.` se traduce a `->` automáticamente cuando el
// identificador es de tipo `ptr<T>`.
// V22 (Memory Model v2) §PR#2: make_unique + coerción T → ptr<T>.

class Counter {
  value: number;
  constructor(v: number) { this.value = v; }
}

function inspect(p: ptr<Counter>): void {
  print(numberToString(p.value));
}

const owner: ptr<Counter> = new Counter(7);
inspect(move(owner));