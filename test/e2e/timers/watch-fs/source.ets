// Test e2e: watchFs crea el watcher correctamente.
// El programa vigila /tmp (directorio que siempre existe) y
// se auto-termina tras 1.5s via el timeout del runner.
// El callback de watchFs NO se ejecuta (el test runtime
// test_wrappers_v29.cpp ya cubre eso; este test verifica
// la integracion codegen -> runtime + type-checker).
let w: FsWatcher = watchFs("/tmp", (ev: FsEvent): void => {
  print("change:");
  print(ev.path());
}, false);
print("watching");
