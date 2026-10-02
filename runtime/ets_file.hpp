#pragma once

#include "runtime/ets_async.hpp"
#include "runtime/ets_io_uring.hpp"
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <filesystem>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

namespace ets::file_detail {

inline std::string systemError(const std::string& operation, const std::string& path) {
    return operation + ": " + path + ": " + std::strerror(errno);
}

inline bool writeAll(int descriptor, const std::string& contents, const std::string& path, std::string& error) noexcept {
    std::size_t offset = 0;
    while (offset < contents.size()) {
        const ssize_t written = ::write(descriptor, static_cast<const void*>(contents.data() + offset), contents.size() - offset);
        if (written > 0) { offset += static_cast<std::size_t>(written); continue; }
        if (written < 0 && errno == EINTR) continue;
        error = systemError("Error durante la escritura", path);
        return false;
    }
    return true;
}

inline bool store(const std::string& path, const std::string& contents, int flags, const std::string& openMessage, std::string& error) noexcept {
    const int descriptor = ::open(path.c_str(), O_WRONLY | O_CREAT | flags, 0666);
    if (descriptor < 0) { error = systemError(openMessage, path); return false; }
    const bool written = writeAll(descriptor, contents, path, error);
    const int closeResult = ::close(descriptor);
    if (!written) return false;
    if (closeResult != 0) { error = systemError("Error cerrando el archivo", path); return false; }
    error.clear();
    return true;
}

} // namespace ets::file_detail

inline bool readFile(const std::string& path, std::string& contents, std::string& error) noexcept {
    const int descriptor = ::open(path.c_str(), O_RDONLY);
    if (descriptor < 0) {
        contents.clear();
        error = ets::file_detail::systemError("No se puede leer", path);
        return false;
    }

    struct stat metadata {};
    const bool sized = ::fstat(descriptor, &metadata) == 0 && metadata.st_size > 0 && S_ISREG(metadata.st_mode);
    contents.clear();
    if (sized) contents.resize(static_cast<std::size_t>(metadata.st_size));

    std::size_t offset = 0;
    while (offset < contents.size()) {
        const auto received = ::read(descriptor, contents.data() + offset, contents.size() - offset);
        if (received > 0) { offset += static_cast<std::size_t>(received); continue; }
        if (received == 0) { contents.resize(offset); break; }
        if (errno == EINTR) continue;
        error = ets::file_detail::systemError("Error durante la lectura", path);
        contents.clear();
        ::close(descriptor);
        return false;
    }

    char buffer[64 * 1024];
    for (;;) {
        const auto received = ::read(descriptor, buffer, sizeof(buffer));
        if (received > 0) { contents.append(buffer, static_cast<std::size_t>(received)); continue; }
        if (received == 0) break;
        if (errno == EINTR) continue;
        error = ets::file_detail::systemError("Error durante la lectura", path);
        contents.clear();
        ::close(descriptor);
        return false;
    }
    if (::close(descriptor) != 0) {
        error = ets::file_detail::systemError("Error cerrando el archivo", path);
        contents.clear();
        return false;
    }
    error.clear();
    return true;
}

inline bool writeFile(const std::string& path, const std::string& contents, std::string& error) noexcept {
    return ets::file_detail::store(path, contents, O_TRUNC, "No se puede escribir", error);
}

inline bool appendFile(const std::string& path, const std::string& contents, std::string& error) noexcept {
    return ets::file_detail::store(path, contents, O_APPEND, "No se puede abrir para anexar", error);
}

inline bool fileExists(const std::string& path) noexcept {
    std::error_code statusError;
    const bool exists = std::filesystem::is_regular_file(path, statusError);
    return !statusError && exists;
}

inline bool copyFile(const std::string& source, const std::string& destination, std::string& error) noexcept {
    std::error_code copyError;
    const bool copied = std::filesystem::copy_file(source, destination, std::filesystem::copy_options::none, copyError);
    if (copyError || !copied) {
        error = "No se puede copiar '" + source + "' a '" + destination + "'";
        if (copyError) error = error + ": " + copyError.message();
        return false;
    }
    error.clear();
    return true;
}

inline bool moveFile(const std::string& source, const std::string& destination, std::string& error) noexcept {
    std::error_code moveError;
    std::filesystem::rename(source, destination, moveError);
    if (moveError) {
        error = "No se puede mover '" + source + "' a '" + destination + "': " + moveError.message();
        return false;
    }
    error.clear();
    return true;
}

inline bool removeFile(const std::string& path, std::string& error) noexcept {
    std::error_code removeError;
    const bool removed = std::filesystem::remove(path, removeError);
    if (removeError || !removed) {
        error = "No se puede eliminar: " + path;
        if (removeError) error = error + ": " + removeError.message();
        return false;
    }
    error.clear();
    return true;
}

// Wrappers primitivos (sin Result<T>) para uso desde el dialecto hasta V1.
// Nombres con prefijo `etsFs` para evitar colisión con las versiones
// `Result<T>` de arriba que tienen el mismo nombre base (`readFile`/
// `writeFile`/etc.). El dialecto expone `fileRead`/`fileWrite`/... y el
// codegen los traduce a estos `etsFs*` (ver src/codegen/cpp-generator.ts).
inline std::string etsFsRead(const std::string& path) {
    std::string contents;
    std::string error;
    if (!readFile(path, contents, error)) return std::string();
    return contents;
}

inline bool etsFsWrite(const std::string& path, const std::string& contents) {
    std::string error;
    return writeFile(path, contents, error);
}

inline bool etsFsAppend(const std::string& path, const std::string& contents) {
    std::string error;
    return appendFile(path, contents, error);
}

inline bool etsFsCopy(const std::string& source, const std::string& destination) {
    std::string error;
    return copyFile(source, destination, error);
}

inline bool etsFsMove(const std::string& source, const std::string& destination) {
    std::string error;
    return moveFile(source, destination, error);
}

inline bool etsFsRemove(const std::string& path) {
    std::string error;
    return removeFile(path, error);
}

// Issue V1: cuando estén disponibles las tagged unions, los wrappers arriba
// se reemplazan por versiones que devuelven Result<FileContent, FileError>.

inline ets::Result<std::string> readFile(const std::string& path) {
    std::string contents;
    std::string error;
    return readFile(path, contents, error) ? ets::ok(std::move(contents)) : ets::err<std::string>(std::move(error));
}

inline ets::Result<bool> writeFile(const std::string& path, const std::string& contents) {
    std::string error;
    return writeFile(path, contents, error) ? ets::ok(true) : ets::err<bool>(std::move(error));
}

inline ets::Result<bool> appendFile(const std::string& path, const std::string& contents) {
    std::string error;
    return appendFile(path, contents, error) ? ets::ok(true) : ets::err<bool>(std::move(error));
}

inline ets::Result<bool> copyFile(const std::string& source, const std::string& destination) {
    std::string error;
    return copyFile(source, destination, error) ? ets::ok(true) : ets::err<bool>(std::move(error));
}

inline ets::Result<bool> moveFile(const std::string& source, const std::string& destination) {
    std::string error;
    return moveFile(source, destination, error) ? ets::ok(true) : ets::err<bool>(std::move(error));
}

inline ets::Result<bool> removeFile(const std::string& path) {
    std::string error;
    return removeFile(path, error) ? ets::ok(true) : ets::err<bool>(std::move(error));
}

inline ets::Task<ets::Result<std::string>> readFileAsync(std::string path) {
    co_return co_await ets::runBlocking([path = std::move(path)] {
#if defined(__linux__) && defined(__NR_io_uring_setup) && defined(__NR_io_uring_enter)
        if (ets::ioUringAvailable()) return ets::io_uring_detail::read(path);
#endif
        return readFile(path);
    });
}

inline ets::Task<ets::Result<bool>> writeFileAsync(std::string path, std::string contents) {
    co_return co_await ets::runBlocking([path = std::move(path), contents = std::move(contents)] {
#if defined(__linux__) && defined(__NR_io_uring_setup) && defined(__NR_io_uring_enter)
        if (ets::ioUringAvailable()) return ets::io_uring_detail::write(path, contents, false);
#endif
        return writeFile(path, contents);
    });
}

inline ets::Task<ets::Result<bool>> appendFileAsync(std::string path, std::string contents) {
    co_return co_await ets::runBlocking([path = std::move(path), contents = std::move(contents)] {
#if defined(__linux__) && defined(__NR_io_uring_setup) && defined(__NR_io_uring_enter)
        if (ets::ioUringAvailable()) return ets::io_uring_detail::write(path, contents, true);
#endif
        return appendFile(path, contents);
    });
}

inline ets::Task<ets::Result<bool>> fileExistsAsync(std::string path) {
    co_return co_await ets::runBlocking([path = std::move(path)] {
        std::error_code error;
        const bool exists = std::filesystem::is_regular_file(path, error);
        return error ? ets::err<bool>("No se puede consultar: " + path + ": " + error.message()) : ets::ok(exists);
    });
}

inline ets::Task<ets::Result<bool>> copyFileAsync(std::string source, std::string destination) {
    co_return co_await ets::runBlocking([source = std::move(source), destination = std::move(destination)] { return copyFile(source, destination); });
}

inline ets::Task<ets::Result<bool>> moveFileAsync(std::string source, std::string destination) {
    co_return co_await ets::runBlocking([source = std::move(source), destination = std::move(destination)] { return moveFile(source, destination); });
}

inline ets::Task<ets::Result<bool>> removeFileAsync(std::string path) {
    co_return co_await ets::runBlocking([path = std::move(path)] { return removeFile(path); });
}

template <typename T, typename Function>
ets::Result<T> fileOperationUntil(double timeoutMilliseconds, const ets::CancellationToken& token, Function operation) {
    if (token.isCancelled()) return ets::err<T>("Operación de archivo cancelada");
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(static_cast<long long>(timeoutMilliseconds < 0 ? 0 : timeoutMilliseconds));
    auto result = operation();
    if (token.isCancelled()) return ets::err<T>("Operación de archivo cancelada");
    if (std::chrono::steady_clock::now() > deadline) return ets::err<T>("Operación de archivo excedió el deadline");
    return result;
}

inline ets::Task<ets::Result<std::string>> readFileUntil(std::string path, double timeoutMilliseconds, ets::CancellationToken token) {
    co_return co_await ets::runBlocking([path = std::move(path), timeoutMilliseconds, token] {
        return fileOperationUntil<std::string>(timeoutMilliseconds, token, [&] { return readFile(path); });
    });
}

inline ets::Task<ets::Result<bool>> writeFileUntil(std::string path, std::string contents, double timeoutMilliseconds, ets::CancellationToken token) {
    co_return co_await ets::runBlocking([path = std::move(path), contents = std::move(contents), timeoutMilliseconds, token] {
        return fileOperationUntil<bool>(timeoutMilliseconds, token, [&] { return writeFile(path, contents); });
    });
}

inline ets::Task<ets::Result<bool>> appendFileUntil(std::string path, std::string contents, double timeoutMilliseconds, ets::CancellationToken token) {
    co_return co_await ets::runBlocking([path = std::move(path), contents = std::move(contents), timeoutMilliseconds, token] {
        return fileOperationUntil<bool>(timeoutMilliseconds, token, [&] { return appendFile(path, contents); });
    });
}

inline ets::Task<ets::Result<bool>> copyFileUntil(std::string source, std::string destination, double timeoutMilliseconds, ets::CancellationToken token) {
    co_return co_await ets::runBlocking([source = std::move(source), destination = std::move(destination), timeoutMilliseconds, token] {
        return fileOperationUntil<bool>(timeoutMilliseconds, token, [&] { return copyFile(source, destination); });
    });
}

inline ets::Task<ets::Result<bool>> moveFileUntil(std::string source, std::string destination, double timeoutMilliseconds, ets::CancellationToken token) {
    co_return co_await ets::runBlocking([source = std::move(source), destination = std::move(destination), timeoutMilliseconds, token] {
        return fileOperationUntil<bool>(timeoutMilliseconds, token, [&] { return moveFile(source, destination); });
    });
}

inline ets::Task<ets::Result<bool>> removeFileUntil(std::string path, double timeoutMilliseconds, ets::CancellationToken token) {
    co_return co_await ets::runBlocking([path = std::move(path), timeoutMilliseconds, token] {
        return fileOperationUntil<bool>(timeoutMilliseconds, token, [&] { return removeFile(path); });
    });
}
