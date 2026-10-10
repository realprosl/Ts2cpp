# cpp-httplib (vendored)

Versión: v0.60.1 (MIT, Copyright (c) 2017 yhirose).

Single-file HTTP/HTTPS server + client, header-only. C++11 mínimo.

## Por qué lo vendoreamos

Es el backend HTTP **default** del dialecto (cuando el usuario no añade
`@cpp_drogon`). Es header-only, sin dependencias, soporta HTTP/1.1 server
y client, y HTTPS con OpenSSL (opt-in). 23k lineas en un único `.h`.

## Uso

- El dialecto `#include "runtime/ets_http_httplib.hpp"` que envuelve
  `httplib.h` con la API del dialecto.
- El runner e2e linka `runtime/external/httplib/httplib.cc` con la macro
  `CPPHTTPLIB_COMPILE` definida para emitir las definiciones de templates
  una sola vez.

## Compilar un programa que use HTTP (sin instalar nada)

```bash
g++ -std=c++20 -I. -DCPPHTTPLIB_COMPILE \
    programa.cpp \
    runtime/external/httplib/httplib.cc \
    -lpthread -o programa
```

## Activar HTTPS

Define `CPPHTTPLIB_OPENSSL_SUPPORT` antes del include en
`runtime/ets_http_httplib.hpp` y linka con `-lssl -lcrypto`.

## Licencia

MIT. Ver `LICENSE` en este directorio.
