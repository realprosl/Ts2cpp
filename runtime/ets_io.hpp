#pragma once

// V16: IO básico + console estilo JS + Math + Date. Se incluye siempre
// porque casi todos los programas usan `print` o `console.log` para
// depurar. Si el usuario realmente no quiere este coste, puede usar la
// opción `--minimal` del CLI (en desarrollo).

#include <cctype>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <iostream>
#include <random>
#include <sstream>
#include <string>
#include <vector>
#include "runtime/ets_core.hpp"

template <typename... Args>
inline void print(const Args&... args) {
    (std::cout << ... << args) << std::endl;
}

// V28: numberToString en el global (sin namespace ets) para que el
// codegen del dialecto lo emita como llamada libre. Vive tambien en
// ets::string_numberToString para uso desde C++.
inline std::string numberToString(double value) {
    char buffer[64];
    const auto converted = std::to_chars(buffer, buffer + sizeof(buffer), value);
    return converted.ec == std::errc{} ? std::string(buffer, converted.ptr) : std::string();
}

template <typename... Args>
inline void write(const Args&... args) {
    (std::cout << ... << args);
    std::cout.flush();
}

template <typename... Args>
inline void printError(const Args&... args) {
    (std::cerr << ... << args) << std::endl;
}

template <typename... Args>
inline void writeError(const Args&... args) {
    (std::cerr << ... << args);
    std::cerr.flush();
}

// API estilo Node (`console.log`, `console.error`, ...).
struct ets_console {
    template <typename... Args>
    static void log(const Args&... args) { print(args...); }
    template <typename... Args>
    static void info(const Args&... args) { print(args...); }
    template <typename... Args>
    static void debug(const Args&... args) { print(args...); }
    template <typename... Args>
    static void trace(const Args&... args) { print(args...); }
    template <typename... Args>
    static void warn(const Args&... args) { printError(args...); }
    template <typename... Args>
    static void error(const Args&... args) { printError(args...); }
};

inline ets_console console{};

// `Math` (Bloque E): operaciones numéricas básicas sobre `double` que
// envuelven `<cmath>` con una API ergonómica estilo TypeScript.
struct ets_math {
    static double floor(const double value) noexcept { return std::floor(value); }
    static double ceil(const double value) noexcept { return std::ceil(value); }
    static double round(const double value) noexcept { return std::round(value); }
    static double abs(const double value) noexcept { return std::fabs(value); }
    static double sqrt(const double value) noexcept { return std::sqrt(value); }
    static double pow(const double base, const double exponent) noexcept { return std::pow(base, exponent); }
    static double min(const double left, const double right) noexcept { return left < right ? left : right; }
    static double max(const double left, const double right) noexcept { return left > right ? left : right; }
    // V30.22.2: `random()` devuelve un double en [0, 1). Usa el Mersenne
    // Twister via <random> para mejor calidad que `std::rand()`.
    static double random() noexcept {
        // Seeding: solo una vez al primer call (thread-safe via static).
        static std::mt19937 generator{std::random_device{}()};
        std::uniform_real_distribution<double> dist(0.0, 1.0);
        return dist(generator);
    }
};

// V30.22.2: constantes matematicas como funciones (`PI()` y `E()` devuelven
// el valor). El dialecto no tiene propiedades estaticas no-funcion, asi
// que se modelan como funciones que devuelven el valor constante. El
// codegen se encarga de emitir `Math.PI` → `ets::math_pi()` automaticamente.
namespace ets_math_consts {
    inline double math_pi() noexcept { return 3.14159265358979323846; }
    inline double math_e() noexcept { return 2.71828182845904523536; }
}
namespace ets {
    inline double math_pi() noexcept { return ets_math_consts::math_pi(); }
    inline double math_e() noexcept { return ets_math_consts::math_e(); }
}

inline ets_math Math{};

// `Date` (Bloque E): API mínima estilo JavaScript para tiempo.
struct ets_date {
    static double now() noexcept {
        return static_cast<double>(std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count());
    }
    static double utc(const double year, const double month, const double day) noexcept {
        std::tm time{};
        time.tm_year = static_cast<int>(year) - 1900;
        time.tm_mon = static_cast<int>(month);
        time.tm_mday = static_cast<int>(day);
        time.tm_isdst = 0;
        return static_cast<double>(static_cast<std::int64_t>(timegm(&time)) * 1000);
    }
};

inline ets_date Date{};