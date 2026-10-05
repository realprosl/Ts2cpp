// Selector de backend de EventLoop.
//
// Por ahora solo el backend poll (ETS_EVENT_BACKEND=poll) está
// implementado. El backend libuv se añadirá en Fase 2B en un PR
// separado, una vez validado standalone.
//
// Uso por parte del resto del runtime:
//   #include "ets_event_loop.hpp"
//   // ets::EventLoop es el alias del backend elegido.

#pragma once

#include "ets_event_loop_iface.hpp"

#if defined(ETS_EVENT_BACKEND_LIBUV)
  #error "Backend libuv no disponible todavía. Ver runtime/ets_event_loop.hpp."
#elif defined(ETS_EVENT_BACKEND_POLL) || !defined(ETS_EVENT_BACKEND)
  #include "ets_event_loop_poll.hpp"
  namespace ets { using EventLoop = PollEventLoop; }
#else
  #error "ETS_EVENT_BACKEND desconocido. Valores válidos: poll."
#endif
