# Build System (V25) — Guía completa

Este documento describe el build system de Ts2cpp para el backend C++,
diseñado para que el usuario final **no necesite instalar dependencias
externas** en su sistema. Toda la cadena de compilación (librerías C++
vendoreadas + runtime pre-compilado + scripts de build) vive dentro del
propio repositorio Ts2cpp.

## Resumen ejecutivo

| Componente | Cómo se obtiene | Cómo se compila |
|---|---|---|
| Compilador C++ (g++) | El usuario lo instala (`apt install g++` o equivalente) | — |
| `cmake` (para vendoring) | El usuario lo instala (`apt install cmake`) | — |
| libuv (Fase 1) | Submódulo git `third_party/libuv/` | `scripts/build-libuv.sh` |
| BoringSSL (Fase 2) | Submódulo git `third_party/boringssl/` | `scripts/build-boringssl.sh` |
| libcurl (Fase 3) | Submódulo git `third_party/curl/` | `scripts/build-curl.sh` |
| `runtime_ets_*.o` (Fase 4) | Pre-compilado desde `runtime/runtime_ets_*.cpp` | `scripts/build-runtime.sh` |

**Lema**: el usuario solo necesita `g++`, `cmake`, `make` y `git`. Las
tres dependencias externas (libuv, OpenSSL, libcurl) están vendoreadas
en el repo y se compilan desde fuentes con un solo comando.

## Flujo del usuario

### 1. Instalación inicial

```bash
git clone --recurse-submodules https://github.com/realprosl/Ts2cpp.git
cd Ts2cpp

# El CLI detecta automáticamente las dependencias que faltan y las
# compila. Pero el usuario puede forzarlo:
scripts/build-libuv.sh      # ~35s cold compile
scripts/build-boringssl.sh # ~2 min cold compile
scripts/build-curl.sh      # ~30s cold compile (depende de BoringSSL)
scripts/build-runtime.sh    # ~6s cold compile (runtime_ets_*.o)

# O todo en uno (V25 Fase 6):
# el CLI invoca estos scripts automáticamente la primera vez que se
# necesita una libreria.
```

### 2. Compilar un proyecto Ts2cpp

```bash
npm start -- build mi-proyecto
```

El CLI:
1. Transpila `.ets` → `.cpp`.
2. Detecta qué librerías vendoreadas necesita el programa (vía
   `linkLibraries` en `estatic.config.ts` o `@cpp_link` en `.lib.ets`).
3. Si las `.a` vendoreadas no existen en `build/libs/<lib>/lib/`,
   invoca `scripts/build-<lib>.sh` automáticamente.
4. Si los `.o` del runtime no existen en `build/`, invoca
   `scripts/build-runtime.sh` automáticamente.
5. Compila el `.cpp` del usuario con g++.
6. Enlaza con las `.a` vendoreadas (estáticas, no necesita -l del sistema).
7. Genera el binario.

### 3. Builds subsecuentes (warm cache)

```bash
npm start -- build mi-proyecto
# Todos los caches HIT (libuv.a, libssl.a, libcurl.a, runtime_ets_*.o).
# Tiempo: ~100ms para invocar el binario pre-compilado.
```

El cache **persiste entre proyectos** en:
- `build/libs/<lib>/lib/<lib>.a` (local del repo Ts2cpp).
- `~/.cache/etsc/runtime/<ver>/<backend>/<hash>/` (global, compartido).

## Capas del build system

### Capa 1 — Vendoring de librerías

**Propósito**: que el usuario no necesite `apt install libuv-dev libssl-dev libcurl4-openssl-dev`.

**Mecanismo**:
- Cada librería externa es un **submódulo git** en `third_party/`.
- Un **script de build** (`scripts/build-<lib>.sh`) compila la librería
  estáticamente desde fuentes con cmake + make.
- Salida: `.a` estáticos en `build/libs/<lib>/lib/`.

**Librerías vendoreadas actualmente**:

| Librería | Versión pineada | Tamaño cold | Tiempo cold |
|---|---|---|---|
| libuv | v1.48.0 (commit `e9f29cb9`) | 364 KB | ~35s |
| BoringSSL | HEAD al añadir submódulo | 53 MB total | ~2 min |
| libcurl | HEAD al añadir submódulo | 6 MB | ~30s (tras BoringSSL) |

**Submódulos futuros** (no implementados): tree-sitter (ya vendoreado
como carpeta, PR futuro), abseil, etc.

### Capa 2 — Pre-compilación del runtime a `.o`

**Propósito**: que el usuario no recompile `runtime/ets_*.hpp` cada vez
que compila un programa Ts2cpp.

**Mecanismo**:
- Las definiciones no-template de `LibuvEventLoop` y `PollEventLoop`
  están en `runtime/runtime_ets_*.cpp`.
- El script `scripts/build-runtime.sh` las compila a `.o` con
  cache HIT/MISS (por timestamp).
- Salida: `build/runtime_ets_poll.o` (24 KB) y `build/runtime_ets_libuv.o` (36 KB).

**Cache local** (1 proyecto):
- Cold compile: ~6s.
- Warm cache: ~40ms (150x speedup).

**Cache global** (`~/.cache/etsc/`):
- Key = `sha256(version + backend + flags-que-afectan-ABI)[:16]`.
- Compartido entre proyectos del mismo usuario.
- Patrón similar a `npm cache` o `pip cache`.

### Capa 3 — Integración en el CLI

**Propósito**: UX transparente — el usuario no invoca scripts
manualmente, todo lo hace el CLI automáticamente.

**Mecanismo**:
- `src/cli.ts` calcula qué librerías necesita el programa generado.
- Si hay `.a` vendoreado disponible, lo enlaza directamente.
- Si no, ejecuta `scripts/build-<lib>.sh` y luego enlaza.
- Si el `.o` del runtime no existe en `build/`, busca en
  `~/.cache/etsc/`, o ejecuta `scripts/build-runtime.sh`.

**Tabla de auto-vendoring** (`src/cli.ts`):

```typescript
const vendoredLibs = {
  uv: { script: "build-libuv.sh", libPath: "build/libs/libuv/lib/libuv.a" },
  ssl: { script: "build-boringssl.sh", libPath: "build/libs/boringssl/lib/libssl.a" },
  crypto: { script: "build-boringssl.sh", libPath: "build/libs/boringssl/lib/libcrypto.a" },
  curl: { script: "build-curl.sh", libPath: "build/libs/curl/lib/libcurl.a" },
};
```

## Scripts de build

| Script | Llama a cmake | Llama a make | Output |
|---|---|---|---|
| `build-libuv.sh` | sí | sí | `build/libs/libuv/lib/libuv.a` |
| `build-boringssl.sh` | sí | `make ssl crypto` (no tests) | `build/libs/boringssl/lib/{libssl,libcrypto}.a` |
| `build-curl.sh` | sí | `make libcurl_static` (no binario CLI) | `build/libs/curl/lib/libcurl.a` |
| `build-runtime.sh` | no | no (usa g++ directo) | `build/runtime_ets_{poll,libuv}.o` |

Todos los scripts:
- Validan que el submódulo esté inicializado.
- Validan `cmake` instalado.
- Tienen cache HIT/MISS (si el output existe, no recompilan).
- Imprimen mensaje claro al usuario.

## Limitaciones conocidas

- **`make install` falla en libcurl** porque intenta construir el
  binario CLI `curl` que necesita paquetes extra. Por eso el script
  copia manualmente `libcurl.a` y los headers.
- **BoringSSL no tiene ABI estable**: el pin por commit es estricto.
  Si actualizas el submódulo, los `.a` cacheados quedan obsoletos.
- **Solo Linux**: cmake + BoringSSL + libcurl funcionan en Linux. macOS
  y Windows pueden necesitar ajustes menores.
- **cmake requerido**: `apt install cmake` (Linux) o `brew install cmake`
  (macOS). Sin cmake, el usuario no puede compilar las librerías
  vendoreadas (pero sí puede usar las del sistema).

## Decisiones de diseño

- **No usar Docker**: cada plataforma tiene su propio glibc/SDK. Docker
  sería cross-platform pero añade complejidad y rompe el lema
  "transpilador en un solo bloque".
- **Estática, no dinámica**: `.a` en lugar de `.so`. El binario
  resultante es **independiente del sistema** (no necesita LD_LIBRARY_PATH).
- **Submódulos, no packages**: el código fuente va con el repo. No hay
  "dependency hell" estilo npm para librerías C++.
- **Vendoring + auto-build, no pre-built binaries**: las `.a` se compilan
  en la máquina del usuario. Cero problemas de ABI entre distros.
- **Cache local + global**: `build/` por proyecto + `~/.cache/etsc/`
  compartido. Patrón similar a Go modules.

## Métricas

### Crecimiento · Build cold (sin cache)

| Componente | Tiempo | Disco |
|---|---|---|
| libuv | ~35s | 364 KB |
| BoringSSL | ~2 min | 53 MB |
| libcurl (tras BoringSSL) | ~30s | 6 MB |
| runtime_ets_*.o | ~6s | 60 KB |
| **TOTAL** | **~3.5 min** | **~60 MB** |

### Build warm (todos los caches HIT)

| Componente | Tiempo | Disco |
|---|---|---|
| libuv | 28ms | — |
| BoringSSL | 2.4s | — |
| libcurl | 1s | — |
| runtime_ets_*.o | 40ms | — |
| **TOTAL verificación de cache** | **<5s** | — |

### Build de un programa Ts2cpp (V25 completo)

| Escenario | Tiempo | vs V24 (antes) |
|---|---|---|
| Cold (primer build del usuario) | ~10s (incluye CLI checks) | ~5s (sin vendoring) |
| Warm (segundo build, mismo proyecto) | ~100ms | ~2s |
| **Speedup warm** | — | **20x** |

## Roadmap V25

| Fase | Descripción | PR | Estado |
|---|---|---|---|
| 1 | Vendoring libuv | #119 | ✅ merged |
| 4 | Pre-compilar runtime a `.o` | #120 | ✅ merged |
| 4.6 | CLI integra `.o` | #121 | ✅ merged |
| 5 | Cache global `~/.cache/etsc/` | #122 | ✅ merged |
| 6 | UX transparente | #123 | ✅ merged |
| 2 | Vendoring BoringSSL | #124 | ✅ merged |
| 3 | Vendoring libcurl | #125 | ✅ merged |
| 7 | Documentación final (este doc) | #126 | 🟡 en PR |
| 4.3 | Mover `FdAwaiter`/`UvFdAwaiter` a `.cpp` | pendiente | futuro |

Tras mergear la Fase 7, V25 está **completo**. Los siguientes pasos
serían V26 (optimización del reactor, ver `MEMORY.md`) o V24.x
(mejoras de V23/V24).