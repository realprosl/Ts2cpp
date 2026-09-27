// decorator-demo.ets — Fase 1.5: decoradores (@deprecated).
//
// Los decoradores son syntactic sugar ejecutado en compile-time. El dialecto
// reconoce decoradores de clase, de campo y de método. Solo `@deprecated`
// tiene semántica: cuando se aplica a un método, el método emite un warning
// a stderr en cada llamada. Otros decoradores como `@sealed` son admitidos
// pero no producen efecto runtime (reservan el mecanismo para Fase 3).
//
// `@deprecated("msg")` toma un mensaje opcional. Sin mensaje, se usa "deprecated".

@sealed
class Widget {
  size: number;
  constructor(s: number) { this.size = s; }

  // Deprecated con mensaje.
  @deprecated("use size field instead")
  getOldSize(): number { return this.size; }

  // Deprecated sin mensaje (default).
  @deprecated
  doNothing(): void { }
}

const w = new Widget(42);
print(w.size);              // 42 (sin warning, no es deprecated)
print(w.getOldSize());      // 42 (warning a stderr)
w.doNothing();              // sin stdout (void), warning a stderr
