// runtime/ets_timer.hpp — setTimeout / setInterval one-shot sobre libuv.
//
// V29.4: añade setTimeout(cb, ms) y setInterval(cb, ms) que envuelven
// uv_timer_t con UV_TIMER_ONE_SHOT o repetitivo. Es el equivalente
// de JavaScript setTimeout/setInterval pero en C++ sobre libuv.
//
// Diferencia con sleep():
//   - sleep() suspende la corutina actual (usa el event loop).
//   - setTimeout() lanza un callback DESPUES de N ms, sin suspender
//     a quien lo llama. La corutina sigue ejecutando.
//
// Uso:
//   auto t = ets::setTimeout([]{ printf("fires\n"); }, 200);
//   ...
//   ets::cancelTimer(t);
//
// El handle se mantiene vivo mientras no se cancele. Los callbacks
// se llaman desde el loop principal (no thread-safe).
//
// Compilacion: linka libuv (-luv). Sin flags extra.

#pragma once

#include <cstdint>
#include <functional>
#include <utility>

#include <uv.h>

#include "runtime/ets_async.hpp"  // para defaultEventLoop

namespace ets {

// Forward declaration: la factory detail::makeTimer asigna al campo
// privado handle_, asi que la declaramos antes de la class Timer
// para que el friend la vea.
class Timer;
namespace detail { inline Timer makeTimer(std::function<void()> cb, uint64_t ms, bool repeat); }

class Timer {
public:
    Timer() = default;
    explicit Timer(uv_timer_t* handle) : handle_(handle) {}
    Timer(const Timer&) = delete;
    Timer& operator=(const Timer&) = delete;
    Timer(Timer&& other) noexcept : handle_(other.handle_) {
        other.handle_ = nullptr;
    }
    Timer& operator=(Timer&& other) noexcept {
        if (this != &other) {
            reset();
            handle_ = other.handle_;
            other.handle_ = nullptr;
        }
        return *this;
    }
    ~Timer() { reset(); }

    void reset() {
        if (!handle_) return;
        uv_timer_stop(handle_);
        uv_close(reinterpret_cast<uv_handle_t*>(handle_), [](uv_handle_t* h) {
            delete reinterpret_cast<uv_timer_t*>(h);
        });
        handle_ = nullptr;
    }

    bool valid() const noexcept { return handle_ != nullptr; }

private:
    friend Timer detail::makeTimer(std::function<void()> cb, uint64_t ms, bool repeat);
    friend Timer setTimeout(std::function<void()> cb, uint64_t timeoutMs);
    friend Timer setInterval(std::function<void()> cb, uint64_t intervalMs);
    friend void cancelTimer(Timer& t);
    uv_timer_t* handle_ = nullptr;
};

namespace detail {

// Crea y arranca un uv_timer_t ligado al loop por defecto.
// Devuelve un Timer invalido si falla la inicializacion.
inline Timer makeTimer(std::function<void()> cb, uint64_t ms, bool repeat) {
    Timer t;
    uv_timer_t* handle = new uv_timer_t{};
    t.handle_ = handle;
    uv_loop_t* loop = defaultEventLoop.raw_loop();
    if (!loop) {
        delete handle;
        t.handle_ = nullptr;
        return t;
    }
    if (uv_timer_init(loop, handle) != 0) {
        delete handle;
        t.handle_ = nullptr;
        return t;
    }
    handle->data = new std::function<void()>(std::move(cb));
    if (uv_timer_start(handle, [](uv_timer_t* h) {
            auto* cb = static_cast<std::function<void()>*>(h->data);
            if (!cb || !*cb) return;
            (*cb)();
        }, ms, repeat ? ms : 0) != 0) {
        delete static_cast<std::function<void()>*>(handle->data);
        uv_close(reinterpret_cast<uv_handle_t*>(handle), [](uv_handle_t* hh) {
            delete reinterpret_cast<uv_timer_t*>(hh);
        });
        t.handle_ = nullptr;
        return t;
    }
    return t;
}

}  // namespace detail

// setTimeout — programa cb() para que se ejecute una vez
// despues de timeoutMs milisegundos. Devuelve un Timer que el
// caller debe mantener vivo (o cancel()).
inline Timer setTimeout(std::function<void()> cb, uint64_t timeoutMs) {
    return detail::makeTimer(std::move(cb), timeoutMs, /*repeat=*/false);
}

// setInterval — programa cb() para que se ejecute cada intervalMs
// milisegundos hasta que se cancele. Devuelve un Timer.
inline Timer setInterval(std::function<void()> cb, uint64_t intervalMs) {
    return detail::makeTimer(std::move(cb), intervalMs, /*repeat=*/true);
}

// cancelTimer — alias de reset() para simetria con la API JS.
inline void cancelTimer(Timer& t) { t.reset(); }

}  // namespace ets
