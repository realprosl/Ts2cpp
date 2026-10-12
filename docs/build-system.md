# Build System — Guía actual (V30.6.0)

Este documento describe cómo se compila un proyecto Ts2cpp hoy. Es la
realidad del sistema a partir de V30.6.0 (PRs #169, #170, #171, #172).

## TL;DR

1. `git clone https://github.com/realprosl/Ts2cpp.git`
2. `cd Ts2cpp && npm install` — pre-compila runtime, ofrece `npm link` para `etsc` global.
3. `cd ~/mi-proyecto && etsc init && etsc --build` — genera un binario.

## Cómo se compila un proyecto de usuario

Cuando ejecutas `etsc --build` (o `etsc archivo.ets -o salida.cpp --unity`):

1. **Parse + type-check + codegen** del código fuente. Se genera:
   - `estatic_common.hpp` (header bundle que incluye `runtime/ets_runtime_full.hpp`)
   - Un `main.cpp` por módulo (modo incremental) o un `app.cpp` unificado (modo `--unity`).

2. **AST detection** (`src/modules/runtime-backends.ts`):
   - Recorre el AST y declara qué backends runtime usa el programa.
   - Backends posibles: `libuv` (tcp/dns/timers/fs watchers), `curl` (cliente HTTP), `tls` (OpenSSL), `io_uring` (opcional).
   - Reemplaza la heurística antigua de "escanear includes del cpp".

3. **Linker**:
   - `libuv` → añade `build/runtime_ets_libuv.o`, `build/runtime_ets_net_libuv.o`, `-luv`.
   - `tls` → añade `-lssl -lcrypto`.
   - `curl` → añade `-lcurl`.
   - `io_uring` → (no implementado en V30.6.0).

## Cómo se obtiene el runtime pre-compilado

El runtime (`runtime/runtime_ets_libuv.cpp` y `runtime/runtime_ets_net_libuv.cpp`)
se compila a `.o` cacheados en `build/`. **Hay dos caminos**:

### a) `npm install` (recomendado)

`scripts/postinstall.sh` se ejecuta automáticamente tras `npm install`:

- Detecta la distro (`/etc/os-release` o `uname`): debian, ubuntu, fedora, arch, alpine, macos.
- Comprueba que `libuv-dev`, `libcurl-dev`, `libssl-dev` están instaladas.
  - Si faltan: imprime el comando exacto para tu distro.
  - `--with-sysdeps` las instala con `sudo` (peligroso, opcional).
  - `--skip-sysdeps` salta el chequeo.
- Compila los `.o` con `g++ -std=c++20 -O2 -DETS_EVENT_BACKEND_LIBUV`.
- Ofrece `npm link` para hacer `etsc` global (solo en TTY; en CI imprime instrucciones).

### b) Build manual

Si no quieres usar `postinstall.sh` (por ejemplo en CI sin red), el flujo es:

```bash
g++ -std=c++20 -O2 -I. -DETS_EVENT_BACKEND_LIBUV \
    -c runtime/runtime_ets_libuv.cpp -o build/runtime_ets_libuv.o
g++ -std=c++20 -O2 -I. -DETS_EVENT_BACKEND_LIBUV \
    -c runtime/runtime_ets_net_libuv.cpp -o build/runtime_ets_net_libuv.o
```

## Dependencias

### De sistema (las necesita el usuario)

| Librería | Paquete Debian/Ubuntu | Propósito |
|---|---|---|
| libuv 1.48+ | `libuv1-dev` | Event loop, tcp, dns, timers, fs watchers |
| OpenSSL 3.0+ | `libssl-dev` | TLS (V30.5+) |
| libcurl 8.5+ | `libcurl4-openssl-dev` | Cliente HTTP (V30.3+) |
| g++ 13+ con C++20 | `g++` / `build-essential` | Compilador C++ |

### Vendored (dentro del repo)

| Librería | Ubicación | Cuándo se usa |
|---|---|---|
| cpp-httplib | `runtime/external/httplib/httplib.h` | Backend HTTP default (header-only) |
| BoringSSL (opcional) | `third_party/boringssl/` | Drogon backend (no usado en flujo default) |

**NO** se usan los submodulos git `third_party/libuv/` ni `third_party/curl/`.
V29.3 (PR #157) eliminó los builds vendored. El sistema actual linkea
dinámicamente contra las libs del sistema.

## Estructura de un proyecto de usuario

```
mi-proyecto/
├── estatic.config.ts    # config (entry, output, compiler flags)
├── src/
│   └── main.ts          # código fuente
└── build/               # generado
    ├── .estatic/
    │   ├── generated/
    │   │   └── estatic_common.hpp
    │   └── cache/       # .o de módulos cacheados
    └── app              # binario
```

`estatic.config.ts` mínimo:

```ts
export default {
  entry: "src/main.ts",
  moduleRoots: ["src"],
  aliases: {},
  output: { cpp: "build/app.cpp", binary: "build/app" },
  compiler: {
    enabled: true,
    command: "g++",
    flags: ["-std=c++20", "-O2", "-pthread", "-fno-exceptions"],
    linkFlags: [],
  },
};
```

No hace falta añadir `-luv`, `-lssl`, etc. — el cli lo hace desde el AST.

## Lo que NO existe (antiguo, ya no se usa)

- `scripts/build-libuv.sh` — ya no se usa. V29.3 lo dejó obsoleto.
- `scripts/build-boringssl.sh` — solo para Drogon, no en flujo default.
- `scripts/build-curl.sh` — ya no se usa. libcurl viene del sistema.
- Submodulos `third_party/{libuv,curl,boringssl}/` — V29.3 los eliminó.

## Modo `--unity` vs `--build`

| Modo | Comando | Output | Cuándo |
|---|---|---|---|
| Incremental (default) | `etsc --build` | `main.cpp` por módulo, link incremental | Desarrollo, builds rápidos |
| Unity build | `etsc --unity` | `app.cpp` único, compilación monolítica | Cold build, CI |

El `postinstall` se ejecuta en ambos modos. El AST detection funciona igual.

## Verificación

```bash
# 1. Clonar
git clone https://github.com/realprosl/Ts2cpp.git
cd Ts2cpp && npm install

# 2. Crear proyecto de prueba
etsc init /tmp/test
cd /tmp/test
cp /ruta/a/Ts2cpp/examples/http-server.ets src/main.ts

# 3. Compilar
etsc --build
# Esperado: rc=0, "Build incremental (miss): 1 módulo..."

# 4. Ejecutar
./build/app
# Esperado: servidor escuchando en 127.0.0.1:8080

# 5. Verificar linkado contra libuv
ldd ./build/app | grep libuv
# Esperado: libuv.so.1 => /lib/x86_64-linux-gnu/libuv.so.1
```
