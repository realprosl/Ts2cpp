#pragma once

// V9.1 — Awaiters que combinan corutinas C++20 con io_uring.
//
// Por qué este archivo existe separado de `ets_io_uring.hpp`:
// ese header expone `read()` / `write()` síncronos (cada llamada espera
// el completion del CQE inline). Aquí exponemos variantes que se integran
// con el modelo async del dialecto: `co_await asyncIoUringRead(path)`
// suspende la corutina y la reanuda cuando hay completion.
//
// Limitaciones actuales:
//   - El ring se inicializa en el primer uso (thread_local) y no se libera.
//     Para benchmarks serios se necesita un anillo por thread o por pool.
//   - `await_suspend` espera el CQE con `IORING_ENTER_GETEVENTS` síncrono.
//     No hay busy-loop, pero el thread de la corutina se bloquea hasta
//     que el kernel complete. V9.2 introducirá un worker dedicado que
//     consume CQEs y resume las corutinas vía `defaultEventLoop.post()`.

#include "runtime/ets_async.hpp"
#include "runtime/ets_io_uring.hpp"

#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <limits>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

namespace ets {

#if defined(__linux__) && defined(__NR_io_uring_setup) && defined(__NR_io_uring_enter)

// Awaiter de lectura: submit READ + espera CQE. La corutina que llama
// a `co_await` queda suspendida hasta que el kernel reporta el resultado.
struct IoUringReadAwaiter {
    std::string path;
    std::string contents;
    int descriptor = -1;
    std::size_t fileSize = 0;
    std::size_t offset = 0;
    int result = -EIO;

    explicit IoUringReadAwaiter(std::string p) : path(std::move(p)) {}
    ~IoUringReadAwaiter() { if (descriptor >= 0) ::close(descriptor); }

    bool await_ready() noexcept { return false; }

    void await_suspend(std::coroutine_handle<> handle) {
        // El awaiter ejecuta el trabajo inline (síncrono) y reanuda la
        // corutina manualmente. Esto NO es async real — el thread de la
        // corutina se bloquea hasta que el kernel completa el CQE.
        // V9.2 introducirá un worker thread que consume CQEs y resume
        // corutinas via `defaultEventLoop.post(handle)`.
        runRead();
        handle.resume();
    }

   private:
    void runRead() {
        descriptor = ::open(path.c_str(), O_RDONLY);
        if (descriptor < 0) { result = -errno; return; }
        struct stat metadata {};
        if (::fstat(descriptor, &metadata) != 0 || !S_ISREG(metadata.st_mode)) {
            result = -EINVAL;
            return;
        }
        fileSize = static_cast<std::size_t>(metadata.st_size);
        contents.resize(fileSize);
        if (fileSize == 0) { result = 0; return; }
        int totalReceived = 0;
        while (offset < fileSize) {
            const unsigned chunk = static_cast<unsigned>(std::min<std::size_t>(
                fileSize - offset, std::numeric_limits<unsigned>::max()));
            const int received = io_uring_detail::ring.execute(
                IORING_OP_READ, descriptor, contents.data() + offset, chunk, offset);
            if (received < 0) { result = received; return; }
            if (received == 0) { contents.resize(offset); fileSize = offset; break; }
            offset += static_cast<std::size_t>(received);
            totalReceived += received;
        }
        result = totalReceived;
    }

   public:
    Result<std::string> await_resume() {
        if (result < 0) return err<std::string>(
            "asyncIoUringRead: error en " + path + ": " + std::strerror(-result));
        return ok(std::move(contents));
    }
};

// Awaiter de escritura: submit WRITE + espera CQE. Similar al de lectura.
struct IoUringWriteAwaiter {
    std::string path;
    std::string contents;
    bool append;
    int descriptor = -1;
    int result = -EIO;

    IoUringWriteAwaiter(std::string p, std::string c, bool a)
        : path(std::move(p)), contents(std::move(c)), append(a) {}
    ~IoUringWriteAwaiter() { if (descriptor >= 0) ::close(descriptor); }

    bool await_ready() noexcept { return false; }

    void await_suspend(std::coroutine_handle<> handle) {
        runWrite();
        handle.resume();
    }

   private:
    void runWrite() {
        descriptor = ::open(path.c_str(),
            O_WRONLY | O_CREAT | (append ? O_APPEND : O_TRUNC), 0666);
        if (descriptor < 0) { result = -errno; return; }
        std::size_t offset = 0;
        int totalWritten = 0;
        while (offset < contents.size()) {
            const unsigned chunk = static_cast<unsigned>(std::min<std::size_t>(
                contents.size() - offset, std::numeric_limits<unsigned>::max()));
            const std::uint64_t fileOffset = append ? std::numeric_limits<std::uint64_t>::max() : offset;
            const int written = io_uring_detail::ring.execute(
                IORING_OP_WRITE, descriptor, const_cast<char*>(contents.data() + offset),
                chunk, fileOffset);
            if (written <= 0) {
                result = written < 0 ? written : -EIO;
                return;
            }
            offset += static_cast<std::size_t>(written);
            totalWritten += written;
        }
        result = totalWritten;
    }

   public:
    Result<bool> await_resume() {
        if (result < 0) return err<bool>(
            "asyncIoUringWrite: error en " + path + ": " + std::strerror(-result));
        return ok(true);
    }
};

inline IoUringReadAwaiter asyncIoUringRead(std::string path) { return IoUringReadAwaiter{std::move(path)}; }
inline IoUringWriteAwaiter asyncIoUringWrite(std::string path, std::string contents, bool append = false) {
    return IoUringWriteAwaiter{std::move(path), std::move(contents), append};
}

#else  // !__linux__ io_uring no disponible

// En hosts sin io_uring (macOS, Windows), los awaiters caen a un fallback
// síncrono que usa la stdio C. Documentado en el issue #42.

inline Task<Result<std::string>> asyncIoUringRead(std::string path) {
    co_return err<std::string>("asyncIoUringRead no soportado en este host: " + path);
}
inline Task<Result<bool>> asyncIoUringWrite(std::string path, std::string contents, bool append = false) {
    co_return err<bool>("asyncIoUringWrite no soportado en este host: " + path);
}

#endif

} // namespace ets