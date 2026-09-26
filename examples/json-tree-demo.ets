// json-tree-demo.ets — Bloque 7: JSON.parse con árboles dinámicos.
//
// `JSON.parseValue(s)` devuelve un `JsonValue`, un tipo opaco (variant) que
// puede contener string/number/boolean/null/array/object. El dialecto
// no tiene `Object`/`any`/`unknown`, así que el acceso a campos se hace
// a través de funciones helper globales: `jsonIsString(v)`,
// `jsonObjectGet(v, "key")`, `jsonArrayGet(v, i)`, etc.
//
// Limitaciones del runtime:
//   - Las variables top-level no pueden llamar a `JSON.parse` durante la
//     inicialización estática (C++ static init order es indefinido). Se
//     deben asignar dentro del cuerpo de funciones que se llamen desde
//     `main`. Aquí usamos una función helper para evitar el problema.

// Helper: dado un JSON object, imprime el valor asociado a `key`.
function printIfString(v: JsonValue, key: string): void {
  if (jsonIsObject(v)) {
    const field: JsonValue = jsonObjectGet(v, key);
    if (jsonIsString(field)) {
      print(jsonAsString(field));
    }
  }
}

// Helper: imprime la longitud de un array si lo es.
function printArrayLen(v: JsonValue): void {
  if (jsonIsArray(v)) {
    print(jsonArrayLength(v));
  }
}

// Parsear un objeto con campos primitivos.
function demoObject(): void {
  const src: string = '{"name": "alice", "age": 30, "active": true}';
  const v: JsonValue = JSON.parseValue(src);
  printIfString(v, "name");
  const age: JsonValue = jsonObjectGet(v, "age");
  if (jsonIsNumber(age)) {
    print(jsonAsNumber(age));
  }
}

// Parsear un array.
function demoArray(): void {
  const src: string = '["a", "b", "c"]';
  const v: JsonValue = JSON.parseValue(src);
  printArrayLen(v);
  const first: JsonValue = jsonArrayGet(v, 0);
  if (jsonIsString(first)) {
    print(jsonAsString(first));
  }
}

// JSON anidado (array dentro de object).
function demoNested(): void {
  const src: string = '{"tags": ["admin", "user"], "data": 42}';
  const v: JsonValue = JSON.parseValue(src);
  const tags: JsonValue = jsonObjectGet(v, "tags");
  printArrayLen(tags);
  const data: JsonValue = jsonObjectGet(v, "data");
  if (jsonIsNumber(data)) {
    print(jsonAsNumber(data));
  }
}

demoObject();
demoArray();
demoNested();
