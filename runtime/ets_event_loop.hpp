// Selector de backend de EventLoop.
//
// V29.3: libuv es el unico backend soportado. Antes habia dos
// backends (poll + libuv) seleccionables via -DETS_EVENT_BACKEND_*
// pero el backend poll era un prototipo pre-V25 que se mantuvo por
// compatibilidad. La suite e2e pasa identica con libuv (67/67 sin
// red, 64/65 con red, 1 flake pre-existente), asi que se elimina
// el codigo del backend poll y se simplifica el selector.
//
// Backends disponibles:
//   - libuv (unico): implementacion con libuv (uv_loop_t + uv_poll_t).
//     Requiere enlazar contra libuv (-luv). Activo desde V25 Fase 2B.5,
//     default desde V29.3.
//
// Uso por parte del resto del runtime:
//   #include "ets_event_loop.hpp"
//   // ets::EventLoop es el alias de LibuvEventLoop.

#pragma once

#include "ets_event_loop_iface.hpp"
#include "ets_event_loop_libuv.hpp"

namespace ets { using EventLoop = LibuvEventLoop; }
