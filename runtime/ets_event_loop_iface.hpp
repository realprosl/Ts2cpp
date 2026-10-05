// Interfaz común de los backends de EventLoop.
//
// Define los tipos que un backend de EventLoop necesita
// (WaitResult, CancellationToken, CancellationSource) y la clase
// abstracta IEventLoop que PollEventLoop y LibuvEventLoop implementan.
//
// NO incluir directamente desde código de aplicación. Usar
// runtime/ets_event_loop.hpp, que elige el backend según el macro
// ETS_EVENT_BACKEND.

#pragma once

#include <atomic>
#include <coroutine>
#include <chrono>
#include <memory>

namespace ets {

// --- Cancellation ---------------------------------------------------------

class CancellationToken {
public:
    CancellationToken() = default;
    bool isCancelled() const noexcept { return state_ && state_->load(std::memory_order_acquire); }
private:
    explicit CancellationToken(std::shared_ptr<std::atomic_bool> state) : state_(std::move(state)) {}
    std::shared_ptr<std::atomic_bool> state_;
    friend class CancellationSource;
    friend class IEventLoop;
};

class CancellationSource {
public:
    CancellationSource() : state_(std::make_shared<std::atomic_bool>(false)) {}
    CancellationToken token() const noexcept { return CancellationToken{state_}; }
    void cancel() const noexcept { state_->store(true, std::memory_order_release); }
private:
    std::shared_ptr<std::atomic_bool> state_;
};

// --- Resultado de wait ----------------------------------------------------

enum class WaitResult { ready, timedOut, cancelled };

// --- Interfaz IEventLoop --------------------------------------------------
//
// Métodos que cada backend debe implementar. La API coincide con la
// clase EventLoop original para que el cambio de backend sea
// transparente.

class IEventLoop {
public:
    virtual ~IEventLoop() = default;

    // Espera actividad en un fd (POLLIN/POLLOUT/...). Sin deadline.
    virtual void waitFor(int fd, short events, std::coroutine_handle<> handle) = 0;
    // Espera actividad en un fd con deadline y cancelación.
    virtual void waitForUntil(int fd, short events, std::chrono::steady_clock::time_point deadline, CancellationToken token, WaitResult* result, std::coroutine_handle<> handle) = 0;
    // Programa un timer one-shot al deadline.
    virtual void waitUntil(std::chrono::steady_clock::time_point deadline, std::coroutine_handle<> handle) = 0;
    // Registra un handle detached (cleanup automático al terminar).
    virtual void detach(std::coroutine_handle<> handle) = 0;
    // Encola un handle para ejecutar en la próxima iteración.
    virtual void post(std::coroutine_handle<> handle) = 0;
    // Despierta el loop (interrumpe un runOne bloqueado).
    virtual void notify() noexcept = 0;
    // Procesa un batch de eventos pendientes.
    virtual void runOne() = 0;
};

}  // namespace ets
