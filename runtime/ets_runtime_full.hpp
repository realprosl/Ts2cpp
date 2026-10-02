#include "runtime/ets_runtime.hpp"
#include "runtime/ets_optional.hpp"
#include "runtime/ets_async.hpp"
#include "runtime/ets_file.hpp"
#include "runtime/ets_net.hpp"
#include "runtime/ets_net_sync.hpp"
#include "runtime/ets_process.hpp"
#include <unistd.h>
struct ets_filesystem {
    // --- Sincronas ---------------------------------------------------------
    // Se usa `::readFile` etc. para evitar shadowing con los métodos del propio struct.
    static ets::Result<std::string> readFileSync(const std::string& path) { return ::readFile(path); }
    static ets::Result<bool> writeFileSync(const std::string& path, const std::string& contents) { return ::writeFile(path, contents); }
    static ets::Result<bool> appendFileSync(const std::string& path, const std::string& contents) { return ::appendFile(path, contents); }
    static ets::Result<bool> copyFileSync(const std::string& source, const std::string& destination) { return ::copyFile(source, destination); }
    static ets::Result<bool> renameSync(const std::string& oldPath, const std::string& newPath) { return ::moveFile(oldPath, newPath); }
    static ets::Result<bool> unlinkSync(const std::string& path) { return ::removeFile(path); }
    static bool existsSync(const std::string& path) noexcept { return ::fileExists(path); }

    // --- Asincronas --------------------------------------------------------
    static ets::Task<ets::Result<std::string>> readFile(std::string path) { return ::readFileAsync(std::move(path)); }
    static ets::Task<ets::Result<bool>> writeFile(std::string path, std::string contents) { return ::writeFileAsync(std::move(path), std::move(contents)); }
    static ets::Task<ets::Result<bool>> appendFile(std::string path, std::string contents) { return ::appendFileAsync(std::move(path), std::move(contents)); }
    static ets::Task<ets::Result<bool>> copyFile(std::string source, std::string destination) { return ::copyFileAsync(std::move(source), std::move(destination)); }
    static ets::Task<ets::Result<bool>> rename(std::string oldPath, std::string newPath) { return ::moveFileAsync(std::move(oldPath), std::move(newPath)); }
    static ets::Task<ets::Result<bool>> unlink(std::string path) { return ::removeFileAsync(std::move(path)); }
};

inline ets_filesystem fs{};

// API estilo Node (`path.dirname`, `path.join`, ...). Delega en
// `std::filesystem`. Las funciones que en Node aceptan rest args (`path.join`,
// `path.resolve`) aquí reciben un `std::vector<std::string>` para mantener
// tipos concretos en el lenguaje.
struct ets_path {
    static std::string dirname(const std::string& path) {
        const auto p = std::filesystem::path(path);
        return p.has_parent_path() ? p.parent_path().string() : std::string(".");
    }

    static std::string basename(const std::string& path) {
        return std::filesystem::path(path).filename().string();
    }

    static std::string extname(const std::string& path) {
        return std::filesystem::path(path).extension().string();
    }

    static bool isAbsolute(const std::string& path) {
        return std::filesystem::path(path).is_absolute();
    }

    static std::string normalize(const std::string& path) {
        return std::filesystem::path(path).lexically_normal().string();
    }

    static std::string join(const std::vector<std::string>& parts) {
        std::filesystem::path combined;
        for (const auto& part : parts) {
            if (part.empty()) continue;
            combined /= part;
        }
        return combined.lexically_normal().string();
    }

    static std::string resolve(const std::vector<std::string>& parts) {
        std::filesystem::path combined = std::filesystem::current_path();
        for (const auto& part : parts) {
            if (part.empty()) continue;
            combined /= part;
        }
        std::error_code error;
        const auto canonical = std::filesystem::weakly_canonical(combined, error);
        return error ? combined.string() : canonical.string();
    }
};

inline ets_path path{};

// API estilo Node (`process.argv`, `process.cwd`, ...). Mapea a `argument`,
// `argumentCount`, `exitProcess` y `std::filesystem::current_path`.
struct ets_process {
    static double argc() noexcept { return argumentCount(); }

    static std::vector<std::string> argv() {
        std::vector<std::string> result;
        result.reserve(ets_argc);
        for (int index = 0; index < ets_argc; ++index) result.emplace_back(ets_argv[index]);
        return result;
    }

    static std::string cwd() {
        std::error_code error;
        const auto current = std::filesystem::current_path(error);
        return error ? std::string(".") : current.string();
    }

    [[noreturn]] static void exit(double code) noexcept { exitProcess(code); }
};

inline ets_process process{};

// V16: JSON está en `ets_runtime.hpp` (header base), no se duplica aquí.
// `argument`, `normalizePath`, `compilerRoot`, `resolveImportPath`,
// `pathDirectory`, `resolveProjectPath` viven en `ets_core.hpp`.
