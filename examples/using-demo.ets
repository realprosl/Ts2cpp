// using-demo.ets — Fase 1.9: declaración `using` (TC39 stage 3).
//
// `using name = expr;` declara un recurso con garantía de RAII automático:
// al salir del bloque donde se declaró, el destructor C++ del tipo se
// invoca. Es syntactic sugar sobre `let name = expr` con la semántica
// de que el binding es inmutable y scope-limited.
//
// En el dialecto actual, los tipos runtime (Optional<T>, Task<T>, etc.)
// ya son RAII por diseño, así que `using` se comporta igual que `let`.
// Cuando se añadan destructores user-defined a clases (Fase 3), `using`
// invocará también el método `dispose()` explícitamente.

function demoBasic(): void {
  // Caso 1: `using` con tipo primitivo.
  using greeting: string = "hello";
  print(greeting);

  // Caso 2: `using` con tipo Optional<T> — RAII ya garantiza cleanup.
  using maybe: Optional<number> = optionalSome(42);
  print(numberToString(maybe ?? -1));

  // Caso 3: `using` con tipo vector.
  using items: number[] = [10, 20, 30];
  print(numberToString(items[0]));
  print(numberToString(items[2]));
}

function demoScope(): void {
  // `using` tiene scope de bloque: declarado dentro de un bloque, muere al
  // cerrar la llave. Esto se observa porque la variable no es accesible fuera.
  {
    using local: string = "inside";
    print(local);
  }
  // `local` ya no está en scope aquí. Si intentamos `print(local)`, error.
  print("after-block");
}

demoBasic();
demoScope();
