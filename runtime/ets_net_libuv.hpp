// Backend libuv de las funciones de red async de ets_net.hpp.
//
// Las definiciones de UvFdAwaiter / UvCancellableFdAwaiter estan en
// runtime_ets_net_libuv.cpp (compilable a .o cacheado). Este header
// re-exporta las declaraciones para mantener compatibilidad con
// codigo existente.
//
// Patron: ver runtime/ets_event_loop_libuv.hpp para la version
// completa del backend libuv del EventLoop.

#pragma once

#include "ets_net_libuv_api.hpp"