# Visión Estatic

> **Escribir como TypeScript, conocerlo todo en compilación y pagar en ejecución como C++.**

## 1. Qué es Estatic (y qué no)

Estatic **no es un transpilador de TypeScript a C++**. Esa descripción se queda corta.

Estatic es un **lenguaje** que toma la parte agradable de escribir TypeScript — sintaxis clara, inferencia, genéricos ergonómicos, async, operaciones de colección — y la une con la **ejecución predecible y eficiente de C++** — value semantics, layout de memoria explícito, stack allocation, tipos numéricos reales, corutinas nativas, optimización ahead-of-time.

La diferencia con TypeScript es fundamental. TypeScript acaba ejecutándose como JavaScript sobre un motor dinámico: por mucha información de tipos que tengamos al desarrollar, **gran parte desaparece en ejecución**. Estatic tiene la oportunidad opuesta: cuando sabemos que algo es un `i32`, sigue siendo un `i32` hasta el código máquina. Cuando sabemos que un objeto tiene tres campos concretos, **siguen siendo esos tres campos**.

Esa información sobreviviente es el **superpoder** del dialecto. Y debe guiar cada decisión de diseño: **todo lo que sepamos en compilación deberíamos intentar usarlo para que el programa haga menos trabajo en ejecución**.

## 2. Lo que el dialecto debe ofrecer

### 2.1 Uniones discriminadas y narrowing

Una operación que puede devolver éxito o error: si es éxito contiene un valor; si es error contiene un mensaje. El compilador debe saber que dentro del bloque "éxito" existe el valor, y dentro del bloque "error" existe el mensaje.

Encaja extraordinariamente bien con C++ porque podemos representar esas posibilidades de manera estática y eficiente.

### 2.2 Pattern matching exhaustivo

`match(expr) { case A: ...; case B: ... }`. El compilador verifica en tiempo de compilación que todas las posibilidades están cubiertas. Si mañana añadimos un nuevo estado, el compilador señala todos los sitios donde ahora falta manejarlo.

**Seguridad prácticamente gratuita en runtime.**

### 2.3 Tipos numéricos concretos

`i8`, `i16`, `i32`, `i64`, `u8`, `u16`, `u32`, `u64`, `f32`, `f64`. Distinguir entre enteros con y sin signo, entre flotantes de 32 y 64 bits.

Si estás procesando diez millones de elementos y solo necesitas un byte por elemento, no pagas ocho bytes. Es importante para juegos, servidores, procesamiento de datos, networking, sistemas embebidos o cualquier aplicación donde la memoria y la caché importan.

### 2.4 Arrays de tamaño conocido en compilación

`[T; N]` con N literal. No se trata como colección dinámica que puede crecer, reservar memoria y moverse. Se genera directamente una estructura C++ de N elementos en pila.

Muchas cosas pueden vivir en pila. Desaparecen allocations. El compilador C++ tiene mucha más información para optimizar.

### 2.5 Readonly profundo

`readonly T`, `readonly T[]`, `readonly [T; N]`. En TypeScript sirve para que el programador no haga cosas por error. En Estatic vamos más lejos: si sabemos que una función recibe algo y no lo modifica, generamos `const T&` automáticamente, evitamos copias, damos más información al optimizador.

### 2.6 Fusión automática de operaciones sobre colecciones

`arr.filter(...).map(...).reduce(...)` parece programación funcional. Pero el AST sabe que es "primero filtra, después transforma, después suma". El compilador puede convertirlo en **un único recorrido** de la colección.

Para el programador sigue siendo funcional, muy agradable de leer. Lo que ejecuta la máquina es prácticamente el mismo bucle que escribiría un programador de C++ obsesionado con rendimiento. A esto se le llama **fusión de operaciones** o **fusión de pipelines**, y debería ser la **característica estrella** del dialecto.

### 2.7 Closures específicas, no genéricas

No toda arrow function que se guarda necesita convertirse en `std::function` (abstracción dinámica de C++). Si el AST sabe exactamente qué lambda es, qué captura y dónde se usa, generamos una lambda C++ concreta, inlineable, que el optimizador puede hacer desaparecer.

Solo cuando realmente necesitamos guardar funciones distintas detrás de un mismo tipo pagamos el coste de la abstracción.

### 2.8 Análisis de escape implícito

Si un objeto nunca escapa de una función, no necesita heap. Si sabemos que solo existe un propietario, no necesitamos contadores de referencias. Solo cuando realmente hay propietarios múltiples usamos shared ownership.

Regla: **no pagar por posibilidades que el programa realmente no utiliza**.

### 2.9 Constantes conocidas en compilación

`const N: i32 = 1024`. Si el valor se conoce en compilación, debe propagarse a C++ como `constexpr` o literal.

Eso permite: si una constante determina el tamaño de una estructura, generar directamente una estructura de ese tamaño; si una condición depende solo de constantes, eliminar la rama antes de llegar al compilador C++.

### 2.10 Async nativo

`async`/`await` con la comodidad de TypeScript por arriba, corutinas de C++20 e io_uring en Linux por debajo. La experiencia puede parecerse a Node, la infraestructura está mucho más cerca del sistema operativo.

## 3. Lo que NO hay que hacer

- **No `any`**, **no `unknown`**, **no prototypes dinámicos**, **no duck typing**. Cada una de esas características destruye información que ahora mismo tenemos en compilación. Y nuestro superpoder es tener esa información.
- **No replicar rarezas dinámicas de JavaScript**. No objetos que mágicamente cambian de forma.
- **No construir un optimizador propio**: tenemos a Clang y GCC detrás. Nuestro trabajo es entregarles C++ que conserve toda la información posible y no introduzca abstracciones innecesarias que les dificulten optimizar.
- **No implementar SIMD propio** generando instrucciones del procesador. Primero conseguir bucles limpios, tipos precisos, sin aliasing ni wrappers innecesarios. Después dejar que Clang decida si vectoriza a 4, 8 o 16 elementos a la vez. Eso da muchísimo rendimiento gratis.
- **No tener prisa con las partes sofisticadas del sistema de tipos de TypeScript**, donde el sistema de tipos casi se convierte en un lenguaje paralelo. Antes invertir ese esfuerzo en cosas con traducción clara y eficiente a C++.

## 4. La consecuencia

Estatic deja de estar "a mitad de camino" entre TypeScript y C++. En **experiencia de escritura** está cerca de TypeScript. En **modelo de ejecución** está cerca de C++.

No queremos quedarnos justo en medio y obtener las desventajas de ambos. Queremos:

- De TypeScript: sintaxis sencilla, inferencia, genéricos agradables, async, operaciones sobre colecciones.
- De C++: layout de memoria, value semantics, templates, stack allocation, tipos numéricos reales, corutinas nativas, optimización ahead-of-time.

El AST es el **puente** entre esos dos mundos.

## 5. Regla de oro para decisiones de implementación

Antes de aprobar cualquier feature o refactor, pregúntate:

> ¿Estamos aprovechando una información que ya tenemos en compilación, o estamos trabajando sobre strings y perdiendo esa información?

Si la respuesta es "trabajamos sobre strings", la feature está mal planteada. Hay que llevarla al AST.
