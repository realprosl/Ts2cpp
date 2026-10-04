// memory-ownership.ets — V22: ptr<T> para ownership exclusivo.
//
// V22 (Memory Model v2) separa ownership de borrowing:
//   - T            →  copia (valor independiente)
//   - ref<T>       →  préstamo mutable (T&)
//   - constRef<T>  →  préstamo readonly (const T&)
//   - ptr<T>       →  ownership exclusivo mutable (std::unique_ptr<T>)
//   - constPtr<T>  →  ownership exclusivo readonly (std::unique_ptr<const T>)
//
// `ptr<T>` es move-only: no se puede copiar. Cuando se destruye el último
// owner, el destructor del objeto se llama automáticamente (RAII).
//
// `Rc<T>` (shared ownership) y `Unq<T>` (unique ownership pre-V22) se
// eliminaron. Shared ownership con `weak<T>` se diseñará en un PR futuro.

class Session {
  id: number;
  constructor(id: number) { this.id = id; }
}

function inspect(s: constRef<Session>): number {
  return s.id;
}

const session: Session = new Session(42);
print(numberToString(inspect(session)));  // 42
// session se destruye automáticamente al salir del scope.
