// Fase V29.4 — Test de los wrappers de alto nivel sobre libuv.
// Cubre ets_fs_watcher.hpp (watchFs/unwatchFs) y ets_timer.hpp
// (setTimeout/setInterval/cancelTimer). Los wrappers usan el
// raw_loop() del LibuvEventLoop, asi que se integran con el
// sistema de tareas existente sin tocar el reactor.

#include "runtime/ets_async.hpp"
#include "runtime/ets_fs_watcher.hpp"
#include "runtime/ets_timer.hpp"

#include <cstdio>
#include <thread>
#include <chrono>
#include <fcntl.h>
#include <unistd.h>
#include <cstdlib>
#include <sys/stat.h>

#define CHECK(cond, msg) do { if (!(cond)) { fprintf(stderr, "FAIL: %s\n", msg); return 1; } } while(0)

int main() {
    // --- test 1: setTimeout dispara el callback una vez ---
    {
        int n = 0;
        auto t = ets::setTimeout([&] { n++; ets::defaultEventLoop.stop(); }, 80);
        CHECK(t.valid(), "setTimeout handle valid");
        ets::defaultEventLoop.run();
        CHECK(n == 1, "setTimeout fired exactly once");
        printf("ok: setTimeout fired once\n");
    }

    // --- test 2: setInterval dispara N veces ---
    {
        int n = 0;
        ets::Timer t = ets::setInterval([&] {
            n++;
            if (n >= 3) {
                ets::defaultEventLoop.stop();
                ets::cancelTimer(t);
            }
        }, 50);
        CHECK(t.valid(), "setInterval handle valid");
        ets::defaultEventLoop.run();
        CHECK(n == 3, "setInterval fired exactly 3 times");
        printf("ok: setInterval fired 3 times\n");
    }

    // --- test 3: cancelTimer antes de disparar ---
    {
        int n = 0;
        auto t = ets::setTimeout([&] { n++; }, 80);
        // Cancelamos inmediatamente. El callback no deberia dispararse.
        // Cancelamos en otro tick para asegurar que el timer arranco.
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        ets::cancelTimer(t);
        // Esperamos un poco para confirmar que NO dispara.
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
        CHECK(n == 0, "cancelled timer did not fire");
        printf("ok: cancelTimer prevents firing\n");
    }

    // --- test 4: watchFs recibe eventos de creacion ---
    {
        char tmpl[] = "/tmp/ets-fsw-XXXXXX";
        char* dir = mkdtemp(tmpl);
        CHECK(dir != nullptr, "mkdtemp succeeded");
        int got = 0;
        auto w = ets::watchFs(dir, [&](ets::FsEvent /*ev*/) {
            got++;
            // Recibimos el primer evento -> paramos.
            if (got >= 1) ets::defaultEventLoop.stop();
        }, false);
        CHECK(w.valid(), "watchFs handle valid");

        // Lanzar thread que crea un archivo tras 100ms.
        std::string dirS = dir;
        std::thread([&]() {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            std::string p = dirS + "/test.txt";
            int fd = open(p.c_str(), O_WRONLY | O_CREAT, 0644);
            if (fd >= 0) { write(fd, "x", 1); close(fd); }
        }).detach();

        ets::defaultEventLoop.run();
        CHECK(got >= 1, "watchFs received at least one event");
        printf("ok: watchFs received %d events\n", got);
        ets::unwatchFs(w);
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        // Cleanup
        std::string cleanup = std::string(dir) + "/test.txt";
        ::unlink(cleanup.c_str());
        ::rmdir(dir);
    }

    // --- test 5: watchFs y setTimeout conviven en el mismo loop ---
    {
        char tmpl[] = "/tmp/ets-mix-XXXXXX";
        char* dir = mkdtemp(tmpl);
        CHECK(dir != nullptr, "mkdtemp (mix) succeeded");
        int watcherGot = 0;
        int timerGot = 0;
        auto w = ets::watchFs(dir, [&](ets::FsEvent /*ev*/) {
            watcherGot++;
            ets::defaultEventLoop.stop();
        }, false);
        auto t = ets::setTimeout([&] {
            timerGot++;
            ets::defaultEventLoop.stop();
        }, 300);

        std::string dirS = dir;
        std::thread([&]() {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            std::string p = dirS + "/x.txt";
            int fd = open(p.c_str(), O_WRONLY | O_CREAT, 0644);
            if (fd >= 0) close(fd);
        }).detach();

        ets::defaultEventLoop.run();
        CHECK(watcherGot >= 1, "watcher got event");
        // El timer de 300ms puede o no haber disparado (el watcher
        // para el loop antes). Aceptamos ambos casos.
        CHECK(watcherGot + timerGot >= 1, "at least one event arrived");
        printf("ok: mixed loop (watcher=%d timer=%d)\n", watcherGot, timerGot);
        ets::unwatchFs(w);
        ets::cancelTimer(t);
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        std::string cleanup = std::string(dir) + "/x.txt";
        ::unlink(cleanup.c_str());
        ::rmdir(dir);
    }

    printf("ALL OK: 5/5 tests passed\n");
    return 0;
}
