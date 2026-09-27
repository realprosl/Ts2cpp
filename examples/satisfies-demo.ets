// satisfies-demo.ets — Fase 1.11: operador `expr satisfies T` (TS 4.9).
//
// `expr satisfies T` verifica que `expr` sea asignable a `T`. A diferencia
// de un cast (`as T`), NO cambia el tipo estático: el tipo preservado es
// el inferido, lo que permite que el campo específico siga siendo
// accesible.
//
// En el dialecto (que no distingue entre tipo inferido y declarado), el
// operador se reduce a un type-check con cast implícito: el tipo del
// operando se valida contra T y el resultado tiene tipo T. Esto da la
// misma garantía de verificación que TS 4.9 pero pierde la ventaja de
// preservar tipos literales específicos.

// Caso 1: verificación satisfactoria — el tipo coincide.
const n: number = 42 satisfies number;
print(numberToString(n));

// Caso 2: verificación con literal string.
const s: string = "literal" satisfies string;
print(s);

// Caso 3: verificación con declaración explícita.
const y: number | string = "hello" satisfies number | string;
print(y);

// Caso 4: `satisfies` con tipo Optional<T> (requiere contexto para T).
const baseOptional: number = 10;
const maybe = optionalSome(baseOptional) satisfies Optional<number>;
print(numberToString(maybe ?? -1));
