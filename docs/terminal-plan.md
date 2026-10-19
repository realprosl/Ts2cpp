# Plan solicitado: objeto global console

Estado: primera fase implementada y probada en Linux. Windows/macOS pendientes
de validación nativa. API vigente: [terminal.md](./terminal.md). Petición: control de terminal multiplataforma, implementado
en C++ sin dependencias externas y accesible mediante un objeto desde ETS.

## Contrato y plataformas

- API pública: objeto global `console`, disponible directamente desde ETS sin
  imports ni instanciación. Toda operación pública de terminal se expone bajo
  `console`; no se expone un builtin separado `term`.
- Backend propio en C++, sin bibliotecas de terceros (decisión confirmada).
  Firmas tipadas en el checker e integración en el runtime.
- Windows, Linux y macOS. C++ y APIs nativas del sistema, sin ncurses ni otras
  bibliotecas externas. C++ estándar por sí solo no ofrece todas las operaciones
  de control de terminal: aislar las diferencias mediante compilación condicional.
- Detectar terminal interactiva y salida redirigida; evitar secuencias de control
  en archivos o pipes por defecto y permitir salida de texto normal.
- Separar capacidades soportadas de las solicitadas, con resultados explícitos
  para operaciones que no estén disponibles en la terminal concreta.

## Fases

1. **Implementado:** salida de texto/líneas, flush, colores y estilos, restablecer estilo,
   limpiar pantalla/línea, mover/mostrar/ocultar cursor y consultar filas/columnas.
   Firmas y coordenadas documentadas en `terminal.md`.
2. Entrada: lectura de teclas, modos echo/raw e interacción sin bloqueo cuando
   sea viable. Definir tratamiento de Unicode, teclas especiales y EOF.
3. Sesiones interactivas: pantalla alternativa y restauración mediante RAII
   de los modos, estilo y cursor en las rutas normales de salida/error.
   Documentar límites ante terminación forzada y señales.

## Integración y verificación

- Registrar las firmas en el checker y la emisión C++, sin introducir una
  dependencia de HTTP, libuv o un event loop para la salida básica.
- Ejemplo ETS que use el objeto: colores, progreso y dimensiones; añadir una
  demo de teclado al implementar entrada.
- Pruebas de salida redirigida, capacidades, secuencias emitidas y restauración.
  Probar interacción real con pseudoterminal cuando esté disponible.
- Compilar y ejecutar en cada plataforma antes de marcarla como verificada;
  distinguir soporte implementado de compatibilidad comprobada.

El objeto global `console` está confirmado; sus métodos de logging y terminal
comparten la API pública. Este plan conserva las fases pendientes; la API implementada se documenta
en `terminal.md`.
