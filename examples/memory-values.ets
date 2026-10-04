// memory-values.ets — V22: T significa copia (value semantics).
//
// Antes de V22, el dialecto convertía automáticamente T a `const T&` para
// "optimizar" el ABI. Esto era una optimización semánticamente observable:
// modificar un parámetro T dentro de la función no afectaba al caller (eso
// era copia), pero el compilador no necesariamente lo hacía. La regla era
// ambigua.
//
// V22 fija la semántica: T es copia. Si quieres evitar la copia, debes
// declararlo explícitamente con `ref<T>` o `constRef<T>`.

class Box {
  value: number;
  constructor(v: number) { this.value = v; }
}

function mutateCopy(b: Box): void {
  // T significa copia: este cambio NO afecta al caller.
  b.value = 999;
}

function mutateRef(b: ref<Box>): void {
  // ref<T> es T&: este cambio SÍ afecta al caller.
  b.value = 999;
}

const original: Box = new Box(42);

mutateCopy(original);
print(numberToString(original.value));  // 42 (sin cambio)

mutateRef(original);
print(numberToString(original.value));  // 999 (mutado a través de la referencia)
