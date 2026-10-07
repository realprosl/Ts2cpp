// Selector de backend de EventLoop.
//
// Backends disponibles:
//   - poll (ETS_EVENT_BACKEND_POLL o default): implementación con
//     ::poll(2) + self-pipe. Estable, portable, sin dependencias.
//   - libuv (ETS_EVENT_BACKEND_LIBUV): implementación con libuv.
//     Requiere enlazar contra libuv (-luv). Activo desde Fase 2B.5.
//
// Uso por parte del resto del runtime:
//   #include "ets_event_loop.hpp"
//   // ets::EventLoop es el alias del backend elegido.
//
// Selección:
//   - Si ETS_EVENT_BACKEND_LIBUV está definido → LibuvEventLoop.
//   - Si ETS_EVENT_BACKEND_POLL está definido, o no se ha definido
//     ningún backend → PollEventLoop.
//   - En caso contrario, error de compilación.

#pragma once

#include "ets_event_loop_iface.hpp"

#if defined(ETS_EVENT_BACKEND_LIBUV)
  #include "ets_event_loop_libuv.hpp"
  namespace ets { using EventLoop = LibuvEventLoop; }
#elif defined(ETS_EVENT_BACKEND_POLL) || !defined(ETS_EVENT_BACKEND)
  #include "ets_event_loop_poll.hpp"
  namespace ets { using EventLoop = PollEventLoop; }
#else
  #error "ETS_EVENT_BACKEND desconocido. Valores válidos: poll, libuv."
#endif