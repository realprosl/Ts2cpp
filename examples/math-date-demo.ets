// math-date-demo.ets — Bloque E: APIs estáticas `Math.*` y `Date.*`.
// Reciben y devuelven `number` (mapeado a `double` en C++); no hay objetos
// mutables ni zonas horarias dinámicas (el dialecto evita `Object`/`any`).

// Aritmética básica: redondeo y valores absolutos
print(Math.floor(3.7));        // 3
print(Math.ceil(3.2));         // 4
print(Math.round(3.5));        // 4
print(Math.abs(-7));           // 7
print(Math.sqrt(16));          // 4
print(Math.pow(2, 10));        // 1024
print(Math.min(5, 9));         // 5
print(Math.max(5, 9));         // 9

// Aplicación a un problema real: redondear el área de un círculo de radio 5.
const radius: number = 5;
const circleArea: number = 3.14159265 * radius * radius;
print(Math.round(circleArea)); // 79

// `Date.now()` y `Date.utc(...)` devuelven timestamps en milisegundos.
const now: number = Date.now();
print(now > 0);                // true (asumimos 1970+)

const epoch: number = Date.utc(1970, 0, 1); // 0
print(epoch);                  // 0

// JSON.stringify para strings (existente; nueva: también documentamos en el Bloque E)
const quoted: string = JSON.stringify("hola");
print(quoted);

// JSON.parse: parsea literales JSON escalares; devuelve su representación canónica
const parsed: string = JSON.parse('"hello world"');
print(parsed);
