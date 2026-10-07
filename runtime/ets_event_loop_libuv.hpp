// Backend libuv del EventLoop — header wrapper (back-compat).
//
// Las definiciones estan en runtime_ets_libuv.cpp (compilable a .o
// cacheado). Este header re-exporta las declaraciones para mantener
// compatibilidad con codigo existente que incluye directamente este
// header.
//
// Para evitar recompilar el runtime en cada build, defina
// ETS_RUNTIME_PRECOMPILED y use solo runtime/ets_event_loop_libuv_api.hpp.
//
// NO incluir directamente. Usar runtime/ets_event_loop.hpp.

#pragma once

#include "ets_event_loop_libuv_api.hpp"