// optional-parameter-demo.ets — Fase 1.6: parámetros opcionales con `?`.
//
// `name?: T` se traduce a `Optional<T>` automáticamente: el parámetro
// tiene tipo `Optional<T>` en el cuerpo (igual que si el user escribiera
// `Optional<T>` directamente, sin doble envoltorio). En el call site,
// omitir el argumento lo rellena con `Optional<T>::none()`.
//
// Encadenable con `??` para obtener el valor por defecto.

function greet(name: string, nickname?: string): string {
  const prefix = nickname ?? "(anon)";
  return "hello " + prefix + " (" + name + ")";
}

print(greet("alice"));           // hello (anon) (alice)
print(greet("bob", "bobby"));    // hello bobby (bob)

// `Optional<T>` explícito no se doble-envuelve.
function greetExplicit(name: string, nickname?: Optional<string>): string {
  const prefix = nickname ?? "(anon)";
  return "hi " + prefix + " " + name;
}

print(greetExplicit("carl"));                        // hi (anon) carl
print(greetExplicit("dora", optionalSome("D")));     // hi D dora

// Tres opcionales: omitir los tres usa defaults.
function config(host: string, port?: number, tls?: boolean): string {
  const p = port ?? 80;
  const t = tls ?? false;
  return host + ":" + numberToString(p) + (t ? "/tls" : "");
}

print(config("api.example.com"));                          // api.example.com:80
print(config("api.example.com", 443));                     // api.example.com:443
print(config("api.example.com", 443, true));               // api.example.com:443/tls
