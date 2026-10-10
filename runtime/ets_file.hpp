#pragma once

#include "runtime/ets_async.hpp"
#include "runtime/ets_io_uring.hpp"
#include <algorithm>
#include <array>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <filesystem>
#include <optional>
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

// ─── FileReader: lector por descriptor (streaming) ────────────────────
// A diferencia de readFile() que carga el archivo entero en memoria,
// FileReader mantiene el descriptor abierto y permite leer por
// caracteres o lineas sin copiar todo el contenido. Util para procesar
// archivos grandes (logs, CSVs, JSON streams) donde cargar todo seria
// prohibitivo en RAM.
//
// Uso tipico:
//   let r = FileReader.open("/var/log/app.log")
//   if (r == null) { print("no se pudo abrir"); return }
//   while (!r.eof()) {
//     let line = r.readLine()
//     if (line != null) process(line)
//   }
//   r.close()
class FileReader {
    int descriptor_ = -1;
    bool eof_ = false;
    // Buffer interno para leer bloques del disco y entregar caracteres
    // uno a uno. 64KB es suficiente para evitar syscalls por byte.
    static constexpr std::size_t kBufferSize = 64 * 1024;
    std::array<char, kBufferSize> buffer_{};
    std::size_t bufferPos_ = 0;
    std::size_t bufferEnd_ = 0;

    // Rellena el buffer desde el descriptor. Devuelve false en EOF o error.
    bool refill(std::string& error) {
        for (;;) {
            const auto received = ::read(descriptor_, buffer_.data(), buffer_.size());
            if (received > 0) {
                bufferPos_ = 0;
                bufferEnd_ = static_cast<std::size_t>(received);
                return true;
            }
            if (received == 0) { eof_ = true; return false; }
            if (errno == EINTR) continue;
            error = ets::file_detail::systemError("Error durante la lectura", "<FileReader>");
            return false;
        }
    }

    // Asegura que el buffer tiene al menos `n` bytes disponibles para
    // leer. Si no, hace un read del fd. NO avanza bufferPos_ (peek).
    // Devuelve true si hay al menos `n` bytes disponibles, false en
    // EOF o error.
    bool ensurePeekable(std::size_t n, std::string& error) {
        if (eof_) return false;
        const std::size_t available = bufferEnd_ - bufferPos_;
        if (available >= n) return true;
        // Necesitamos mas bytes. Hacemos un read directo al buffer
        // desplazando los bytes que quedan al inicio.
        if (available > 0) {
            std::memmove(buffer_.data(), buffer_.data() + bufferPos_, available);
        }
        bufferPos_ = 0;
        bufferEnd_ = available;
        for (;;) {
            const auto received = ::read(descriptor_, buffer_.data() + bufferEnd_, buffer_.size() - bufferEnd_);
            if (received > 0) {
                bufferEnd_ += static_cast<std::size_t>(received);
                if (bufferEnd_ >= n) return true;
                continue;
            }
            if (received == 0) { eof_ = true; return false; }
            if (errno == EINTR) continue;
            error = ets::file_detail::systemError("Error durante la lectura", "<FileReader>");
            return false;
        }
    }

public:
    // Abre un archivo. Si no se puede abrir, escribe el error a stderr
    // y aborta con exit(1). El caller siempre obtiene un reader valido.
    // NOTA: esta funcion es la implementacion C++ del factory. En el
    // dialecto se expone como la funcion global `openFileReader` (no como
    // metodo estatico, porque el type-checker actual no soporta
    // `ClassName.staticMethod()`). Devuelve por valor con move semantics
    // para evitar leaks y para que el dialecto pueda hacer
    // `let r: FileReader = openFileReader(path)`.
    static FileReader open(const std::string& path) {
        const int descriptor = ::open(path.c_str(), O_RDONLY);
        if (descriptor < 0) {
            const std::string err = ets::file_detail::systemError("No se puede leer", path);
            std::fprintf(stderr, "FileReader::open: %s\n", err.c_str());
            std::exit(1);
        }
        FileReader reader;
        reader.descriptor_ = descriptor;
        return reader;
    }

    // Constructor vacio: produce un reader "no inicializado" (descriptor = -1).
    // Existe para que el dialecto pueda tratar FileReader como un tipo
    // por valor y hacer `let r: FileReader = openFileReader(path)`. El
    // codegen resuelve `openFileReader(path)` a `*::openFileReader(path)`
    // (desreferencia el puntero raw), lo que copia el reader por valor
    // y transfiere la propiedad del descriptor. Si el reader temporal
    // se destruye sin cerrar, no hay leak porque el destructor cierra.
    // Para C++ directo (no dialecto), usar `open` que devuelve puntero.
    FileReader() = default;

    // Constructor de copia: NECESARIO para que `let r = openFileReader(path)`
    // copie el FileReader devuelto por `open` (que es puntero). El nuevo
    // reader "roba" el descriptor al original (el original queda invalido).
    // Esto es move semantics manual: el reader source ya no se debe usar.
    FileReader(const FileReader& other) noexcept
        : descriptor_(other.descriptor_), eof_(other.eof_),
          buffer_(other.buffer_), bufferPos_(other.bufferPos_), bufferEnd_(other.bufferEnd_) {
        const_cast<FileReader&>(other).descriptor_ = -1;
        const_cast<FileReader&>(other).eof_ = true;
        const_cast<FileReader&>(other).bufferPos_ = 0;
        const_cast<FileReader&>(other).bufferEnd_ = 0;
    }
    FileReader& operator=(const FileReader& other) noexcept {
        if (this != &other) {
            close();
            descriptor_ = other.descriptor_;
            eof_ = other.eof_;
            buffer_ = other.buffer_;
            bufferPos_ = other.bufferPos_;
            bufferEnd_ = other.bufferEnd_;
            const_cast<FileReader&>(other).descriptor_ = -1;
            const_cast<FileReader&>(other).eof_ = true;
            const_cast<FileReader&>(other).bufferPos_ = 0;
            const_cast<FileReader&>(other).bufferEnd_ = 0;
        }
        return *this;
    }
    // Move constructor y move assignment: equivalentes al copy (mismo robo).
    FileReader(FileReader&& other) noexcept : FileReader(static_cast<const FileReader&>(other)) {}
    FileReader& operator=(FileReader&& other) noexcept {
        if (this != &other) {
            close();
            descriptor_ = other.descriptor_;
            eof_ = other.eof_;
            buffer_ = std::move(other.buffer_);
            bufferPos_ = other.bufferPos_;
            bufferEnd_ = other.bufferEnd_;
            other.descriptor_ = -1;
            other.eof_ = true;
            other.bufferPos_ = 0;
            other.bufferEnd_ = 0;
        }
        return *this;
    }

    // Constructor vacio: para uso futuro con descriptores ya abiertos
    // (pipes, sockets, etc.). NO abrir archivos con esto.

    // Destructor: cierra el descriptor si sigue abierto.
    ~FileReader() { close(); }

    // Cierra el descriptor. Despues de esto el reader ya no es usable.
    void close() {
        if (descriptor_ >= 0) {
            ::close(descriptor_);
            descriptor_ = -1;
        }
        eof_ = true;
        bufferPos_ = bufferEnd_ = 0;
    }

    // Devuelve true si estamos al final del archivo.
    bool eof() const { return eof_; }

    // Lee un caracter (1 byte) y avanza el cursor. Devuelve -1 en EOF.
    // Para mantener el API simple y predecible, solo decodificamos ASCII
    // (1 byte) en esta primera version. Si el caracter es multibyte,
    // devolvemos el primer byte (igual que fs.readFileSync en modo
    // binario de Node). Para UTF-8 completo, ver readLine() que
    // decodifica el bloque entero.
    int readChar() {
        if (eof_) return -1;
        if (bufferPos_ >= bufferEnd_) {
            std::string error;
            if (!refill(error)) return -1;
        }
        return static_cast<unsigned char>(buffer_[bufferPos_++]);
    }

    // Mira el siguiente caracter (1 byte) SIN avanzar el cursor.
    // Devuelve -1 en EOF. Util para parsers que necesitan ver antes
    // de consumir (e.g. detectar BOM, lookahead de un solo byte).
    // La proxima llamada a readChar() o read() devuelve el mismo byte.
    int peekChar() {
        if (eof_) return -1;
        if (bufferPos_ >= bufferEnd_) {
            std::string error;
            if (!refill(error)) return -1;
        }
        return static_cast<unsigned char>(buffer_[bufferPos_]);
    }

    // Mira los siguientes n bytes SIN avanzar el cursor. Devuelve un
    // string con hasta n bytes (menos si EOF antes). La proxima
    // llamada a read/readChar devuelve los mismos bytes.
    std::string peek(std::size_t n) {
        if (eof_ || n == 0) return std::string();
        std::string error;
        if (!ensurePeekable(n, error)) {
            // EOF o error: devolvemos lo que tengamos (< n bytes).
            if (bufferEnd_ > bufferPos_) {
                return std::string(buffer_.data() + bufferPos_, bufferEnd_ - bufferPos_);
            }
            return std::string();
        }
        return std::string(buffer_.data() + bufferPos_, n);
    }

    // Lee hasta n bytes (o hasta EOF si n <= 0) y los devuelve como
    // string. Cada llamada puede hacer varias syscalls si el archivo
    // es pequeno, pero para archivos grandes es lineal en el tamano.
    std::string read(std::size_t n = 0) {
        std::string out;
        if (eof_) return out;
        if (n == 0) {
            // Lee hasta EOF. Usamos el buffer interno.
            char buffer[8 * 1024];
            for (;;) {
                const auto received = ::read(descriptor_, buffer, sizeof(buffer));
                if (received > 0) { out.append(buffer, static_cast<std::size_t>(received)); continue; }
                if (received == 0) { eof_ = true; break; }
                if (errno == EINTR) continue;
                eof_ = true;
                break;
            }
            return out;
        }
        // Lee exactamente n bytes (o menos si EOF antes).
        out.reserve(n);
        while (out.size() < n && !eof_) {
            if (bufferPos_ >= bufferEnd_) {
                std::string error;
                if (!refill(error)) break;
            }
            const std::size_t available = bufferEnd_ - bufferPos_;
            const std::size_t needed = n - out.size();
            const std::size_t chunk = std::min(available, needed);
            out.append(buffer_.data() + bufferPos_, chunk);
            bufferPos_ += chunk;
        }
        return out;
    }

    // Lee hasta el proximo '\n' (incluido) y lo devuelve. Si EOF sin
    // encontrar '\n' y no quedan datos, devuelve "" (string vacio). Si
    // el archivo no termina en '\n', la ultima linea se devuelve sin
    // el terminador. Para distinguir EOF de una linea vacia valida,
    // usar eof() antes de llamar.
    std::string readLine() {
        if (eof_ && bufferPos_ >= bufferEnd_) return std::string();
        std::string line;
        for (;;) {
            if (bufferPos_ >= bufferEnd_) {
                std::string error;
                if (!refill(error)) {
                    if (line.empty()) return std::string();
                    return line;
                }
            }
            // Busca '\n' en el buffer restante.
            const char* begin = buffer_.data() + bufferPos_;
            const char* end = buffer_.data() + bufferEnd_;
            const char* nl = std::find(begin, end, '\n');
            if (nl != end) {
                line.append(begin, static_cast<std::size_t>(nl - begin + 1));
                bufferPos_ = static_cast<std::size_t>(nl - buffer_.data()) + 1;
                return line;
            }
            // No hay '\n' en este bloque, seguimos.
            line.append(begin, static_cast<std::size_t>(end - begin));
            bufferPos_ = bufferEnd_;
        }
    }
};

// Factory global expuesta al dialecto. Llamada desde codegen cuando el
// usuario hace `openFileReader(path)`. El dialecto no soporta llamadas
// a métodos estáticos de clase (e.g. `FileReader.open(path)`), por eso
// se expone como función libre con un nombre mnemónico.
inline FileReader openFileReader(const std::string& path) {
    return FileReader::open(path);
}
