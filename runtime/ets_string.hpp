#pragma once

#include <algorithm>
#include <cctype>
#include <charconv>
#include <cstddef>
#include <cstring>
#include <sstream>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>
#include <vector>

// String API byte-level estilo TypeScript. std::string es UTF-8 bytes; todas
// las operaciones trabajan sobre bytes. charCodeAt = byte 0-255, charAt =
// string de 1 byte. Coherente con el resto del runtime (no se asume UTF-16).

namespace ets {

// ----------------------------------------------------------------------------
// length: numero de bytes (== std::string::size).
// ----------------------------------------------------------------------------
inline double string_length(const std::string& value) {
    return static_cast<double>(value.size());
}

// ----------------------------------------------------------------------------
// charAt(i): string de 1 byte en la posicion i, o "" si fuera de rango.
// ----------------------------------------------------------------------------
inline std::string string_charAt(const std::string& value, double index) {
    const auto i = static_cast<std::size_t>(index < 0 ? 0 : index);
    return i < value.size() ? std::string(1, value[i]) : std::string();
}

// ----------------------------------------------------------------------------
// charCodeAt(i): byte en posicion i como double (0-255), o -1 si fuera de rango.
// ----------------------------------------------------------------------------
inline double string_charCodeAt(const std::string& value, double index) {
    const auto i = static_cast<std::size_t>(index < 0 ? 0 : index);
    if (i >= value.size()) return -1.0;
    return static_cast<unsigned char>(value[i]);
}

// ----------------------------------------------------------------------------
// indexOf(needle, start=0): primera posicion de needle, o -1. Si start < 0 o
// needle vacio, devuelve 0 (TS semantics).
// ----------------------------------------------------------------------------
inline double string_indexOf(const std::string& value, const std::string& needle, double start) {
    if (needle.empty()) return 0.0;
    std::size_t from = 0;
    if (start > 0.0) from = static_cast<std::size_t>(start);
    if (from > value.size()) return -1.0;
    const auto found = value.find(needle, from);
    return found == std::string::npos ? -1.0 : static_cast<double>(found);
}

// ----------------------------------------------------------------------------
// lastIndexOf(needle, start=infinito): ultima posicion de needle, o -1.
// ----------------------------------------------------------------------------
inline double string_lastIndexOf(const std::string& value, const std::string& needle) {
    if (needle.empty()) return static_cast<double>(value.size());
    const auto found = value.rfind(needle);
    return found == std::string::npos ? -1.0 : static_cast<double>(found);
}

// ----------------------------------------------------------------------------
// includes(needle, start=0): true si needle aparece a partir de start.
// ----------------------------------------------------------------------------
inline bool string_includes(const std::string& value, const std::string& needle, double start) {
    if (needle.empty()) return true;
    std::size_t from = 0;
    if (start > 0.0) from = static_cast<std::size_t>(start);
    if (from > value.size()) return false;
    return value.find(needle, from) != std::string::npos;
}

// ----------------------------------------------------------------------------
// startsWith(prefix): true si value empieza por prefix.
// ----------------------------------------------------------------------------
inline bool string_startsWith(const std::string& value, const std::string& prefix) {
    return value.size() >= prefix.size() && value.compare(0, prefix.size(), prefix) == 0;
}

// ----------------------------------------------------------------------------
// endsWith(suffix): true si value termina por suffix.
// ----------------------------------------------------------------------------
inline bool string_endsWith(const std::string& value, const std::string& suffix) {
    return value.size() >= suffix.size() &&
           value.compare(value.size() - suffix.size(), suffix.size(), suffix) == 0;
}

// ----------------------------------------------------------------------------
// slice(start, end=length): substring desde start (puede ser negativo) hasta
// end (negativo cuenta desde el final). Equivalente a JS Array.prototype.slice.
// ----------------------------------------------------------------------------
inline std::string string_slice(const std::string& value, double start, double end) {
    const auto size = static_cast<double>(value.size());
    auto clamp = [size](double n) {
        if (n < 0) n = size + n;
        if (n < 0) n = 0;
        if (n > size) n = size;
        return static_cast<std::size_t>(n);
    };
    const auto s = clamp(start);
    const auto e = clamp(end);
    if (e <= s) return std::string();
    return value.substr(s, e - s);
}

// ----------------------------------------------------------------------------
// substring(start, end=length): como slice pero clampea negativos a 0 y
// intercambia start/end si vienen invertidos (TS semantics).
// ----------------------------------------------------------------------------
inline std::string string_substring(const std::string& value, double start, double end) {
    const auto size = static_cast<double>(value.size());
    auto toPos = [size](double n) {
        if (n < 0) n = 0;
        if (n > size) n = size;
        return static_cast<std::size_t>(n);
    };
    auto s = toPos(start);
    auto e = toPos(end);
    if (e < s) std::swap(s, e);
    if (e == s) return std::string();
    return value.substr(s, e - s);
}

// ----------------------------------------------------------------------------
// substr(start, length=length-start): como TS legacy substr.
// ----------------------------------------------------------------------------
inline std::string string_substr(const std::string& value, double start, double length) {
    const auto size = static_cast<double>(value.size());
    double s = start;
    if (s < 0) s = size + s;
    if (s < 0) s = 0;
    if (s > size) return std::string();
    const auto from = static_cast<std::size_t>(s);
    const auto remaining = size - s;
    const auto len = static_cast<std::size_t>(length < 0 ? 0 : (length > remaining ? remaining : length));
    return value.substr(from, len);
}

// ----------------------------------------------------------------------------
// split(separator): corta por separator (string literal) y devuelve vector.
// Sin regex. Si separator es "", devuelve el string como vector de 1.
// ----------------------------------------------------------------------------
inline std::vector<std::string> string_split(const std::string& value, const std::string& separator) {
    std::vector<std::string> result;
    if (separator.empty()) {
        result.push_back(value);
        return result;
    }
    std::size_t start = 0;
    while (true) {
        const auto pos = value.find(separator, start);
        if (pos == std::string::npos) {
            result.push_back(value.substr(start));
            break;
        }
        result.push_back(value.substr(start, pos - start));
        start = pos + separator.size();
    }
    return result;
}

// ----------------------------------------------------------------------------
// trim(): quita espacios (\t \n \r ' ' \v \f) al principio y al final.
// ----------------------------------------------------------------------------
inline std::string string_trim(const std::string& value) {
    const auto first = value.find_first_not_of(" \t\r\n\v\f");
    if (first == std::string::npos) return std::string();
    const auto last = value.find_last_not_of(" \t\r\n\v\f");
    return value.substr(first, last - first + 1);
}

// trimStart / trimEnd
inline std::string string_trimStart(const std::string& value) {
    const auto first = value.find_first_not_of(" \t\r\n\v\f");
    if (first == std::string::npos) return std::string();
    return value.substr(first);
}
inline std::string string_trimEnd(const std::string& value) {
    const auto last = value.find_last_not_of(" \t\r\n\v\f");
    if (last == std::string::npos) return std::string();
    return value.substr(0, last + 1);
}

// ----------------------------------------------------------------------------
// toLowerCase / toUpperCase: byte-level usando unsigned char para evitar UB
// con valores >127. NO es Unicode-correct (UTF-8 multibyte pasaria a ASCII
// si toca letras); pero es byte-level y consistente con la regla del runtime.
// ----------------------------------------------------------------------------
inline std::string string_toLowerCase(const std::string& value) {
    std::string out;
    out.resize(value.size());
    for (std::size_t i = 0; i < value.size(); ++i) {
        out[i] = static_cast<char>(std::tolower(static_cast<unsigned char>(value[i])));
    }
    return out;
}
inline std::string string_toUpperCase(const std::string& value) {
    std::string out;
    out.resize(value.size());
    for (std::size_t i = 0; i < value.size(); ++i) {
        out[i] = static_cast<char>(std::toupper(static_cast<unsigned char>(value[i])));
    }
    return out;
}

// ----------------------------------------------------------------------------
// repeat(count): repite el string count veces. count <= 0 -> "".
// ----------------------------------------------------------------------------
inline std::string string_repeat(const std::string& value, double count) {
    const auto n = static_cast<std::size_t>(count < 0 ? 0 : count);
    if (n == 0 || value.empty()) return std::string();
    std::string out;
    out.reserve(value.size() * n);
    for (std::size_t i = 0; i < n; ++i) out.append(value);
    return out;
}

// ----------------------------------------------------------------------------
// padStart(length, pad=" "): rellena al inicio hasta alcanzar length.
// padStart(length) con 1 argumento -> pad por defecto " " (TS semantics).
// ----------------------------------------------------------------------------
inline std::string string_padStart(const std::string& value, double targetLength, const std::string& pad) {
    const auto target = static_cast<std::size_t>(targetLength < 0 ? 0 : targetLength);
    if (value.size() >= target) return value;
    if (pad.empty()) return value;  // TS devuelve value sin pad si pad vacio
    const std::size_t need = target - value.size();
    std::string out;
    out.reserve(target);
    if (pad.size() >= need) {
        out.append(pad, 0, need);
    } else {
        const std::size_t fullRepeats = need / pad.size();
        const std::size_t tail = need % pad.size();
        for (std::size_t i = 0; i < fullRepeats; ++i) out.append(pad);
        out.append(pad, 0, tail);
    }
    out.append(value);
    return out;
}

// ----------------------------------------------------------------------------
// padEnd(length, pad=" "): rellena al final hasta alcanzar length.
// ----------------------------------------------------------------------------
inline std::string string_padEnd(const std::string& value, double targetLength, const std::string& pad) {
    const auto target = static_cast<std::size_t>(targetLength < 0 ? 0 : targetLength);
    if (value.size() >= target) return value;
    if (pad.empty()) return value;
    const std::size_t need = target - value.size();
    std::string out;
    out.reserve(target);
    out.append(value);
    if (pad.size() >= need) {
        out.append(pad, 0, need);
    } else {
        const std::size_t fullRepeats = need / pad.size();
        const std::size_t tail = need % pad.size();
        for (std::size_t i = 0; i < fullRepeats; ++i) out.append(pad);
        out.append(pad, 0, tail);
    }
    return out;
}

// ----------------------------------------------------------------------------
// replace(search, replacement): primera ocurrencia (TS semantics).
// ----------------------------------------------------------------------------
inline std::string string_replace(const std::string& value, const std::string& search, const std::string& replacement) {
    if (search.empty()) return value;
    const auto pos = value.find(search);
    if (pos == std::string::npos) return value;
    return value.substr(0, pos) + replacement + value.substr(pos + search.size());
}

// ----------------------------------------------------------------------------
// replaceAll(search, replacement): todas las ocurrencias.
// ----------------------------------------------------------------------------
inline std::string string_replaceAll(const std::string& value, const std::string& search, const std::string& replacement) {
    if (search.empty()) return value;
    std::string out;
    out.reserve(value.size());
    std::size_t start = 0;
    while (true) {
        const auto pos = value.find(search, start);
        if (pos == std::string::npos) {
            out.append(value, start, std::string::npos);
            break;
        }
        out.append(value, start, pos - start);
        out.append(replacement);
        start = pos + search.size();
    }
    return out;
}

// ----------------------------------------------------------------------------
// localeCompare(other): comparacion byte-level. < 0 si menor, 0 si igual, > 0
// si mayor. Devuelve -1/0/1 para alinearse con TS que suele devolver +-1.
// ----------------------------------------------------------------------------
inline double string_localeCompare(const std::string& a, const std::string& b) {
    const int cmp = a.compare(b);
    if (cmp < 0) return -1.0;
    if (cmp > 0) return 1.0;
    return 0.0;
}

// ----------------------------------------------------------------------------
// toString: alias identidad (string es ya string).
// ----------------------------------------------------------------------------
inline std::string string_toString(const std::string& value) {
    return value;
}

// ----------------------------------------------------------------------------
// numberToString: ya esta en ets_core.hpp. Redefinido aqui por consistencia
// para que el codegen pueda llamarlo via ets::string_numberToString.
// Tambien exportado en el namespace global (sin prefijo) para que el
// codegen de `numberToString(x)` (que se emite como llamada libre) lo
// encuentre en el linker.
// ----------------------------------------------------------------------------
inline std::string string_numberToString(double value) {
    char buffer[64];
    const auto converted = std::to_chars(buffer, buffer + sizeof(buffer), value);
    return converted.ec == std::errc{} ? std::string(buffer, converted.ptr) : std::string();
}
inline std::string numberToString(double value) {
    return string_numberToString(value);
}

// ----------------------------------------------------------------------------
// string_size: tamano exacto que ocuparia un double si se serializara con
// string_numberToString. Usado por ets::detail::size_of_part (en
// ets_core.hpp) para pre-reservar buffers en ets::concat.
// ----------------------------------------------------------------------------
inline std::size_t string_size(double value) noexcept {
    char buffer[64];
    const auto converted = std::to_chars(buffer, buffer + sizeof(buffer), value);
    return converted.ec == std::errc{} ? static_cast<std::size_t>(converted.ptr - buffer) : 0;
}

// ----------------------------------------------------------------------------
// append_to: append optimizado a un std::string sin alocar temporales.
// Para doubles usa to_chars directo al buffer del string (C++20).
// Usado por ets::concat (en ets_core.hpp) bajo el namespace `detail`.
// ----------------------------------------------------------------------------
namespace detail {
inline void append_to(std::string& out, const std::string& s) { out.append(s); }
inline void append_to(std::string& out, const char* s) { out.append(s); }
inline void append_to(std::string& out, char c) { out.push_back(c); }
inline void append_to(std::string& out, double v) {
    char buffer[64];
    const auto converted = std::to_chars(buffer, buffer + sizeof(buffer), v);
    if (converted.ec == std::errc{}) {
        out.append(buffer, static_cast<std::size_t>(converted.ptr - buffer));
    }
}
inline void append_to(std::string& out, float v) { append_to(out, static_cast<double>(v)); }
inline void append_to(std::string& out, int v) { append_to(out, static_cast<double>(v)); }
inline void append_to(std::string& out, long v) { append_to(out, static_cast<double>(v)); }
inline void append_to(std::string& out, long long v) { append_to(out, static_cast<double>(v)); }
inline void append_to(std::string& out, unsigned v) { append_to(out, static_cast<double>(v)); }
inline void append_to(std::string& out, unsigned long v) { append_to(out, static_cast<double>(v)); }
inline void append_to(std::string& out, unsigned long long v) { append_to(out, static_cast<double>(v)); }
inline void append_to(std::string& out, bool b) { b ? out.append("true", 4) : out.append("false", 5); }
}  // namespace detail

// ----------------------------------------------------------------------------
// length (alias sin prefijo para templates / sobrecarga). Tambien overloads
// para vector y tuple, como en el archivo original.
// ----------------------------------------------------------------------------
inline double length(const std::string& value) {
    return static_cast<double>(value.size());
}
template <typename T>
inline double length(const std::vector<T>& value) {
    return static_cast<double>(value.size());
}
template <typename... T>
inline double length(const std::tuple<T...>&) {
    return static_cast<double>(sizeof...(T));
}

}  // namespace ets
