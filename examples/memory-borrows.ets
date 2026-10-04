// memory-borrows.ets — V22: ref<T> y constRef<T> modelan préstamos.
//
// V22 introduce 4 modificadores de paso:
//   T            copia independiente
//   ref<T>       préstamo mutable no-null (T&)
//   constRef<T>  préstamo readonly no-null (const T&)
//   ptr<T>       ownership exclusivo mutable (std::unique_ptr<T>)
//   constPtr<T>  ownership exclusivo readonly (std::unique_ptr<const T>)
//
// Antes de V22, los préstamos se hacían con `Mut<T>` (T*) o `MutRef<T>` (T&)
// y el dialecto aplicaba heurísticas automáticas. V22 elimina las
// heurísticas: el tipo del parámetro define exactamente la semántica.

class Counter {
  value: number;
  constructor(v: number) { this.value = v; }
}

function increment(counter: ref<Counter>): void {
  // ref<Counter> es T&: el callee muta el valor del caller.
  counter.value = counter.value + 1;
}

function inspect(counter: constRef<Counter>): number {
  // constRef<Counter> es const T&: el callee solo lee.
  return counter.value;
}

const counter: Counter = new Counter(10);
increment(counter);
print(numberToString(inspect(counter)));  // 11
