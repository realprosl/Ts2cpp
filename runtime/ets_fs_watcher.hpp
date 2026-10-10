// runtime/ets_fs_watcher.hpp — Watcher de filesystem sobre libuv.
//
// V29.4: Añade watchFs() que envuelve uv_fs_event_t (inotify en Linux,
// FSEvents en macOS, ReadDirectoryChangesW en Windows via libuv).
// La instancia se ata al loop por defecto de la runtime (no se
// permite custom loop para mantener la API minimal).
//
// Uso tipico:
//   auto handle = ets::watchFs("/tmp/dir", [](FsEvent ev) {
//     printf("cambio en %s, flags=%d\n", ev.path.c_str(), ev.flags);
//   });
//   ... (mas tarde)
//   ets::unwatchFs(handle);
//
// El watcher se mantiene vivo hasta que se llame unwatchFs o se
// destruya. Los callbacks se llaman desde el loop principal (no
// thread-safe: asume single-threaded event loop).
//
// Compilacion: linka libuv (-luv). El runtime ya esta linkado
// desde V29.3, asi que no hay flags extra.

#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <uv.h>

#include "runtime/ets_async.hpp"  // para defaultEventLoop y LibuvEventLoop

namespace ets {

// FsEvent — evento emitido por un watcher de filesystem.
// `path` es el nombre del archivo relativo al directorio vigilado.
// `flags` es una OR de bits UV_RENAME, UV_CHANGE (ver <uv.h>).
struct FsEvent {
    std::string path;
    int flags = 0;
};

// FsWatcher — handle opaco a un uv_fs_event_t. Mantener vivo
// mientras se quiera recibir eventos.
class FsWatcher {
public:
    FsWatcher() = default;
    explicit FsWatcher(uv_fs_event_t* handle) : handle_(handle) {}
    FsWatcher(const FsWatcher&) = delete;
    FsWatcher& operator=(const FsWatcher&) = delete;
    FsWatcher(FsWatcher&& other) noexcept : handle_(other.handle_), callback_(std::move(other.callback_)) {
        other.handle_ = nullptr;
    }
    FsWatcher& operator=(FsWatcher&& other) noexcept {
        if (this != &other) {
            reset();
            handle_ = other.handle_;
            callback_ = std::move(other.callback_);
            other.handle_ = nullptr;
        }
        return *this;
    }
    ~FsWatcher() { reset(); }

    // Cierra el watcher y libera el handle. Idempotente.
    void reset() {
        if (!handle_) return;
        // uv_fs_event_stop es seguro aunque ya este parado.
        uv_fs_event_stop(handle_);
        uv_close(reinterpret_cast<uv_handle_t*>(handle_), [](uv_handle_t* h) {
            delete reinterpret_cast<uv_fs_event_t*>(h);
        });
        handle_ = nullptr;
    }

    // Cierto si el watcher sigue activo.
    bool valid() const noexcept { return handle_ != nullptr; }

private:
    friend FsWatcher watchFs(const std::string& path,
                             std::function<void(FsEvent)> callback,
                             bool recursive);
    friend void unwatchFs(FsWatcher& w);
    uv_fs_event_t* handle_ = nullptr;
    std::function<void(FsEvent)> callback_;
};

// watchFs — inicia un watcher sobre `path` (directorio). `callback`
// se invoca en cada cambio. Si `recursive` es true, vigila también
// subdirectorios (UV_FS_EVENT_RECURSIVE).
//
// Devuelve un FsWatcher que el caller debe mantener vivo. Si el
// path no existe o no es un directorio, devuelve un FsWatcher
// invalido (valid() == false).
inline FsWatcher watchFs(const std::string& path,
                          std::function<void(FsEvent)> callback,
                          bool recursive = false) {
    FsWatcher w;
    uv_fs_event_t* handle = new uv_fs_event_t{};
    handle->data = &w;  // back-pointer para que el callback acceda al FsWatcher

    uv_loop_t* loop = defaultEventLoop.raw_loop();
    if (!loop) {
        delete handle;
        return w;
    }
    if (uv_fs_event_init(loop, handle) != 0) {
        delete handle;
        return w;
    }
    const int flags = recursive ? UV_FS_EVENT_RECURSIVE : 0;
    if (uv_fs_event_start(handle, [](uv_fs_event_t* h, const char* filename, int events, int status) {
            if (status < 0) return;  // error: ignoramos por simplicidad
            auto* w = static_cast<FsWatcher*>(h->data);
            if (!w || !w->callback_) return;
            FsEvent ev;
            ev.path = filename ? std::string(filename) : std::string();
            ev.flags = events;
            w->callback_(std::move(ev));
        }, path.c_str(), flags) != 0) {
        uv_close(reinterpret_cast<uv_handle_t*>(handle), [](uv_handle_t* hh) {
            delete reinterpret_cast<uv_fs_event_t*>(hh);
        });
        return w;
    }
    w.handle_ = handle;
    w.callback_ = std::move(callback);
    return w;
}

// unwatchFs — alias de reset() para simetria con la API.
inline void unwatchFs(FsWatcher& w) { w.reset(); }

}  // namespace ets
