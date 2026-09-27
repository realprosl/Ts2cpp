// Metadata de helpers globales del dialecto Estatic.
//
// Cada helper expone:
// - `minParams`: número mínimo de argumentos.
// - `returnsGeneric: boolean`: si devuelve un genérico construido a partir
//   de sus argumentos (p.ej. `optionalSome<T>(v)` → `Optional<T>`).
// - `returnsRef: boolean`: si devuelve una referencia (no copia).
//
// El type-checker valida los argumentos y el codegen usa esta metadata para
// emitir el tipo C++ correcto (`T` vs `T&`, `ets::Optional<T>` vs `auto`).
//
// NOTA: este objeto DEBE coincidir con las tablas `OPTIONAL_HELPERS`,
// `UN_HELPERS`, `RC_HELPERS`, `REF_HELPERS` y `ASYNC_HELPERS` en
// `src/semantic/type-checker.ts`. Si añades un helper, actualiza ambos
// sitios (mismo patrón que ya usa el dialecto).

export const HELPER_METADATA: Record<string, { minParams: number; returnsGeneric?: boolean; returnsRef?: boolean }> = Object.assign(Object.create(null), {
  // Optional<T>
  optionalSome:      { minParams: 1, returnsGeneric: true },
  optionalNone:      { minParams: 0, returnsGeneric: true },
  optionalIsPresent: { minParams: 1 },
  optionalValueOr:   { minParams: 2 },
  // Result<T,E>
  resultOk:          { minParams: 1, returnsGeneric: true },
  resultErr:         { minParams: 1, returnsGeneric: true },
  resultIsOk:        { minParams: 1 },
  resultValueOr:     { minParams: 2 },
  // Task<T> / Promise<T>
  taskResolve:       { minParams: 1, returnsGeneric: true },
  spawn:             { minParams: 1, returnsGeneric: true },
  // Un<T>
  unSome:            { minParams: 1, returnsGeneric: true },
  unNone:            { minParams: 0, returnsGeneric: true },
  unIsSome:          { minParams: 1 },
  unValue:           { minParams: 1, returnsRef: true },     // T& (no copia)
  // Rc<T>
  rcShare:           { minParams: 1, returnsGeneric: true },
  rcStrongCount:     { minParams: 1 },
  rcValue:           { minParams: 1, returnsRef: true },     // T&
  // MutRef<T>
  mutRefOf:          { minParams: 1, returnsGeneric: true },   // DEPRECATED
  mutRefFrom:        { minParams: 1, returnsGeneric: true },   // DEPRECATED
  mutRefValue:       { minParams: 1, returnsRef: true },        // DEPRECATED
  // Mut<T>
  mutOf:             { minParams: 1, returnsGeneric: true },    // DEPRECATED
  mutFrom:           { minParams: 1, returnsGeneric: true },    // DEPRECATED
  mutValue:          { minParams: 1, returnsRef: true },        // DEPRECATED
  mutIsSome:         { minParams: 1 },                          // DEPRECATED
  // JSON
  parseJson:         { minParams: 1, returnsGeneric: true },
  // Map<K,V>
  mapNew:            { minParams: 0, returnsGeneric: true },
  mapSet:            { minParams: 3 },
  mapGet:            { minParams: 2 },
  mapHas:            { minParams: 2 },
  mapSize:           { minParams: 1 },
  // Set<T>
  setNew:            { minParams: 0, returnsGeneric: true },
  setAdd:            { minParams: 2 },
  setHas:            { minParams: 2 },
  setSize:           { minParams: 1 },
  // Array
  arrayPush:         { minParams: 2 },
  arrayLength:       { minParams: 1 },
  // Filesystem (Issue #13)
  fileRead:          { minParams: 1 },
  fileWrite:         { minParams: 2 },
  fileAppend:        { minParams: 2 },
  fileExists:        { minParams: 1 },
  fileCopy:          { minParams: 2 },
  fileMove:          { minParams: 2 },
  fileRemove:        { minParams: 1 },
});
