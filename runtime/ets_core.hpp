#pragma once

// V16: runtime mínimo que SIEMPRE se incluye. Define:
//   - Variables globales `ets_argc`/`ets_argv` (entry points)
//   - Helpers de argumentos (argument, count)
//   - Exit code
//   - typeofOf<T>() para runtime type queries
//   - Helpers de error handling (fail, clearError, hasError)
//   - ensureParentDirectory (usado por ets_file)
//
// NO contiene nada de IO, ni collections, ni async. Esos viven en sus
// propios headers (ets_io.hpp, ets_collections.hpp, ets_async.hpp).

#include <cstddef>
#include <cstdlib>
#include <filesystem>
#include <sstream>
#include <string>
#include <type_traits>
#include <variant>

inline int ets_argc = 0;
inline char** ets_argv = nullptr;

// Forward declarations de las primitivas libres; permiten que los structs
// estilo Node (`ets_process`) las referencien sin importar el orden.
inline double argumentCount();
[[noreturn]] inline void exitProcess(double code) noexcept;

// `typeof T` estilo TypeScript. Vive en el namespace `ets::` para que el
// codegen pueda llamarlo como `ets::typeofOf<T>()` desde cualquier punto
// sin necesidad de un `using`.
namespace ets {
template <typename T>
inline std::string typeofOf() {
    using U = std::decay_t<T>;
    if constexpr (std::is_same_v<U, double>) return "number";
    else if constexpr (std::is_same_v<U, std::string>) return "string";
    else if constexpr (std::is_same_v<U, bool>) return "boolean";
    else if constexpr (std::is_same_v<U, void>) return "undefined";
    else return "object";
}
} // namespace ets

inline bool fail(const std::string& message, std::string& error) noexcept {
    error = message;
    return false;
}

inline void clearError(std::string& error) noexcept { error.clear(); }
inline bool hasError(const std::string& error) noexcept { return !error.empty(); }

inline bool ensureParentDirectory(const std::string& path, std::string& error) noexcept {
    std::error_code status;
    const auto parent = std::filesystem::path(path).parent_path();
    if (!parent.empty()) std::filesystem::create_directories(parent, status);
    if (status) { error = "No se puede crear el directorio de salida: " + status.message(); return false; }
    return true;
}

inline double argumentCount() { return static_cast<double>(ets_argc); }

[[noreturn]] inline void exitProcess(double code) noexcept {
    std::exit(static_cast<int>(code));
}

inline std::string argument(double index) {
    const auto i = static_cast<int>(index);
    return i >= 0 && i < ets_argc ? std::string(ets_argv[i]) : std::string();
}

// `ets::concat(parts...)`: concatena cualquier número de partes heterogéneas
// en un único `std::string`. Es una de las primitivas más usadas por el
// codegen (template literals, +, etc.) así que vive en el header base.
namespace ets {
template <typename... Parts>
std::string concat(const Parts&... parts) {
    std::ostringstream oss;
    (oss << ... << parts);
    return oss.str();
}
} // namespace ets