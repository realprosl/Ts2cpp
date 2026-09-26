// exports-demo.ets — Fase 1.15: `export default` y `export { name as alias }`.
//
// El dialecto es single-translation-unit, así que `export` no genera
// dispatch runtime: las declaraciones se procesan como top-level normales.
// El AST registra las marcas para tooling (linters, formatters, bundlers).
// En runtime, todo está en el mismo translation unit y los símbolos son
// accesibles directamente.

// `export const`: la variable se declara sin `static` (visible global).
export const PI: number = 3.14159;
export const E: number = 2.71828;

// `export function`: igual que una function top-level pero marcada como pública.
export function square(x: number): number { return x * x; }

// `export default function`: la función se publica como default. En runtime
// el dialecto la procesa como una function normal; el codegen emite un
// marcador `// export default:` antes de la declaración.
export default function greet(name: string): string {
  return "hello " + name;
}

// `export { name }`: re-exporta bindings ya declarados arriba. El alias
// `as <alias>` se registra en el scope del type-checker para que pueda
// usarse como nombre local (es un atajo al símbolo original).
export { PI as PI_RENAMED, E };
export { square as squareFn };

// Las funciones y variables exportadas se pueden usar normalmente en runtime.
print(PI);
print(E);
print(square(5));
print(greet("alice"));
print(PI_RENAMED);
print(squareFn(7));
