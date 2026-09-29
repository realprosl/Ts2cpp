// V9.1 — Awaiters io_uring integrados con corutinas.
// `asyncIoUringRead(path)` retorna un awaiter que se combina con
// `await` dentro de funciones `async`. Internamente usa el ring io_uring
// del runtime (runtime/ets_io_uring_async.hpp) para submit + wait del CQE.

function lengthOf(text: string): number {
  return length(text);
}

async function readAndReport(path: string): Promise<boolean> {
  print("antes de await");
  const result = await asyncIoUringRead(path);
  print("después de await");
  if (result.isOk()) {
    print("size:", lengthOf(result.value()));
    return true;
  }
  print("error:", result.error());
  return false;
}

const okRead = await readAndReport("/root/Ts2cpp/runtime/ets_io_uring.hpp");
print("okRead:", okRead);
