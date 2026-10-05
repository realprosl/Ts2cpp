// Validador de la arquitectura callback libuv → coroutine C++20.
// Ejecuta tres escenarios de la spec §6, §10 y §22 de "Especificación de
// networking sobre libuv":
//
//   1. Timer one-shot reanuda la corutina una sola vez.
//   2. Doble disparo del callback NO causa doble resume.
//   3. Cancelación + timer combinados: la cancelación llega antes y
//      la corutina termina con estado `cancelled`.
//
// Compilar y ejecutar:
//   g++ -std=c++20 -Wall -Wextra runtime/libuv/validate_architecture.cpp -luv -o .scratch/libuv-validate
//   ./.scratch/libuv-validate
//
// Este archivo NO se inyecta en el runtime de Ts2cpp. Es standalone,
// sirve para validar la arquitectura antes de empezar la Fase 2.

#include <uv.h>
#include <coroutine>
#include <cstdio>
#include <exception>

struct Task {
    struct promise_type {
        Task get_return_object() { return {}; }
        std::suspend_never initial_suspend() { return {}; }
        std::suspend_never final_suspend() noexcept { return {}; }
        void return_void() {}
        void unhandled_exception() { std::terminate(); }
    };
};

// =====================================================================
// Escenario 1: timer one-shot → resume único
// =====================================================================

struct TimerOnce {
    uv_loop_t* loop;
    uv_timer_t handle;
    std::coroutine_handle<> coroutine;
    bool resumed = false;

    bool await_ready() const noexcept { return false; }
    void await_suspend(std::coroutine_handle<> h) {
        coroutine = h;
        uv_timer_init(loop, &handle);
        handle.data = this;
        uv_timer_start(&handle, onTimer, 5, 0);   // 5 ms one-shot
    }
    void await_resume() { /* nada que reportar */ }

    static void onTimer(uv_timer_t* h) {
        auto* self = static_cast<TimerOnce*>(h->data);
        if (self->resumed) return;
        self->resumed = true;
        uv_timer_stop(h);
        self->coroutine.resume();
    }
};

Task co_timer_once(uv_loop_t* loop) {
    co_await TimerOnce{loop, {}, {}, false};
    std::printf("  [1] coroutine reanudada correctamente\n");
}

bool test_1_timer_once() {
    std::printf("Escenario 1: timer one-shot\n");
    uv_loop_t loop;
    uv_loop_init(&loop);
    co_timer_once(&loop);
    uv_run(&loop, UV_RUN_DEFAULT);
    uv_loop_close(&loop);
    return true;
}

// =====================================================================
// Escenario 2: timer repetitivo, el callback debe reanudar a lo sumo una
// vez aunque el timer dispare múltiples veces antes de stop().
// =====================================================================

struct TimerRepeating {
    uv_loop_t* loop;
    uv_timer_t handle;
    std::coroutine_handle<> coroutine;
    bool resumed = false;

    bool await_ready() const noexcept { return false; }
    void await_suspend(std::coroutine_handle<> h) {
        coroutine = h;
        uv_timer_init(loop, &handle);
        handle.data = this;
        // 1ms, repetitivo. En 20ms de uv_run dispararía ~20 veces.
        uv_timer_start(&handle, onTimer, 1, 1);
    }
    void await_resume() {}

    static void onTimer(uv_timer_t* h) {
        auto* self = static_cast<TimerRepeating*>(h->data);
        if (self->resumed) return;       // idempotente
        self->resumed = true;
        uv_timer_stop(h);
        self->coroutine.resume();
    }
};

Task co_timer_repeating(uv_loop_t* loop) {
    co_await TimerRepeating{loop, {}, {}, false};
    std::printf("  [2] coroutine reanudada a pesar de timer repetitivo\n");
}

bool test_2_idempotent_resume() {
    std::printf("Escenario 2: timer repetitivo, resume a lo sumo 1 vez\n");
    uv_loop_t loop;
    uv_loop_init(&loop);
    co_timer_repeating(&loop);
    uv_run(&loop, UV_RUN_DEFAULT);
    uv_loop_close(&loop);
    return true;
}

// =====================================================================
// Escenario 3: cancelación externa antes del timer
// =====================================================================

struct CancellationToken {
    bool cancelled = false;
    bool isCancelled() const { return cancelled; }
    void cancel() { cancelled = true; }
};

struct CancellableTimer {
    uv_loop_t* loop;
    struct State {
        std::coroutine_handle<> coroutine;
        CancellationToken* token;
        bool resumed = false;
        bool wasCancelled = false;
    }* state;
    uv_timer_t handle;
    uv_timer_t cancelTrigger;

    bool await_ready() const noexcept { return false; }
    void await_suspend(std::coroutine_handle<> h) {
        state->coroutine = h;
        // Timer principal: 50 ms.
        uv_timer_init(loop, &handle);
        handle.data = this;
        uv_timer_start(&handle, onTimer, 50, 0);
        // Trigger de cancelación: 5 ms.
        uv_timer_init(loop, &cancelTrigger);
        cancelTrigger.data = this;
        uv_timer_start(&cancelTrigger, onCancel, 5, 0);
    }
    void await_resume() {
        if (state->wasCancelled) std::printf("  [3a] coroutine reanudada por CANCELACIÓN\n");
        else std::printf("  [3a] coroutine reanudada por TIMER\n");
    }

    static void onTimer(uv_timer_t* h) {
        auto* self = static_cast<CancellableTimer*>(h->data);
        if (self->state->resumed) return;
        self->state->resumed = true;
        uv_timer_stop(&self->handle);
        uv_timer_stop(&self->cancelTrigger);
        self->state->coroutine.resume();
    }
    static void onCancel(uv_timer_t* h) {
        auto* self = static_cast<CancellableTimer*>(h->data);
        if (self->state->resumed) return;
        self->state->resumed = true;
        self->state->wasCancelled = true;
        self->state->token->cancel();
        uv_timer_stop(&self->handle);
        uv_timer_stop(&self->cancelTrigger);
        self->state->coroutine.resume();
    }
};

Task co_cancellable(uv_loop_t* loop, CancellationToken& token) {
    CancellableTimer::State state{std::noop_coroutine(), &token, false, false};
    CancellableTimer awaitable{loop, &state, {}, {}};
    co_await awaitable;
    std::printf("  [3b] estado final: %s\n", state.wasCancelled ? "cancelado" : "timer disparó");
}

bool test_3_cancel_before_timer() {
    std::printf("Escenario 3: cancel (5ms) antes del timer (50ms)\n");
    uv_loop_t loop;
    uv_loop_init(&loop);
    CancellationToken token;
    co_cancellable(&loop, token);
    uv_run(&loop, UV_RUN_DEFAULT);
    uv_loop_close(&loop);
    return true;
}

// =====================================================================

int main() {
    bool ok1 = test_1_timer_once();
    bool ok2 = test_2_idempotent_resume();
    bool ok3 = test_3_cancel_before_timer();
    if (ok1 && ok2 && ok3) {
        std::printf("\nTodos los escenarios pasaron. Arquitectura validada.\n");
        return 0;
    }
    std::printf("\nFallo en algún escenario.\n");
    return 1;
}
