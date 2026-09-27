#pragma once

#include <cstddef>
#include <cstdlib>
#include <cctype>
#include <chrono>
#include <functional>
#include <filesystem>
#include <iostream>
#include <map>
#include <optional>
#include <sstream>
#include <string>
#include <tuple>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <variant>
#include <vector>
#include "runtime/ets_async.hpp"
#include "runtime/ets_file.hpp"
#include "runtime/ets_net.hpp"
#include "runtime/ets_optional.hpp"
#include "runtime/ets_unq.hpp"
#include "runtime/ets_rc.hpp"
#include "runtime/ets_process.hpp"
#include "runtime/ets_string.hpp"

namespace std {
// `operator<<` para `std::variant`: imprime el valor activo. Permite usar
// directamente `print(valor_de_union)` y concatenarlo con `+`. Definido en
// `std` (patrón canónico) para evitar ambigüedades con el lookup de ADL.
template <typename... Types> requires (sizeof...(Types) > 0)
inline std::ostream& operator<<(std::ostream& stream, const std::variant<Types...>& value) {
    std::visit([&stream](const auto& inner) { stream << inner; }, value);
    return stream;
}
} // namespace std

namespace ets {
// `Map<K, V>` estilo JavaScript envuelto sobre `std::unordered_map`. La API en el
// lenguaje fuente es la de JS (`get`/`set`/`has`/`delete`/`size`/`clear`/`forEach`);
// `delete` no se puede usar como identificador en C++, así que internamente se
// expone como `removeKey`. El codegen mapea `node.method === "delete"` a `removeKey`.
template <typename K, typename V>
class Map {
    std::unordered_map<K, V> data_;
public:
    Map() = default;

    std::optional<V> get(const K& key) const {
        auto it = data_.find(key);
        if (it == data_.end()) return std::nullopt;
        return it->second;
    }

    void set(const K& key, V value) { data_[key] = std::move(value); }

    bool has(const K& key) const { return data_.find(key) != data_.end(); }

    bool removeKey(const K& key) { return data_.erase(key) > 0; }

    std::size_t size() const { return data_.size(); }

    void clear() { data_.clear(); }

    // `forEach(cb)` invoca `cb(value, key)` por cada entrada en orden de inserción.
    template <typename F>
    void forEach(F&& fn) const {
        for (const auto& pair : data_) fn(pair.second, pair.first);
    }

    // Acceso de solo lectura al contenedor subyacente para utilidades internas.
    const std::unordered_map<K, V>& data() const { return data_; }
};

// `Set<T>` estilo JavaScript sobre `std::unordered_set`. Mismo truco con
// `removeKey` para evitar la keyword `delete` de C++.
template <typename T>
class Set {
    std::unordered_set<T> data_;
public:
    Set() = default;

    bool add(const T& value) { return data_.insert(value).second; }

    bool has(const T& value) const { return data_.find(value) != data_.end(); }

    bool removeKey(const T& value) { return data_.erase(value) > 0; }

    std::size_t size() const { return data_.size(); }

    void clear() { data_.clear(); }

    template <typename F>
    void forEach(F&& fn) const {
        for (const auto& value : data_) fn(value);
    }

    const std::unordered_set<T>& data() const { return data_; }
};

// `typeof T` estilo TypeScript. Devuelve el nombre canónico ("number",
// "string", "boolean", "undefined", "object") para el tipo de C++. Usa
// `std::decay_t` para reducir referencias y `const` que `cppType` puede
// añadir al pasar el tipo del operando.
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

using ets::acceptTcp;
using ets::acceptTcpUntil;
using ets::cancel;
using ets::cancellationToken;
using ets::closeTcp;
using ets::createCancellation;
using ets::err;
using ets::listenTcp;
using ets::ok;
using ets::readTcp;
using ets::readTcpUntil;
using ets::sleep;
using ets::spawn;
using ets::writeTcp;
using ets::writeTcpUntil;
using ets::isCancelled;
using ets::ioUringAvailable;

inline int ets_argc = 0;
inline char** ets_argv = nullptr;

// Forward declarations de las primitivas libres definidas más abajo; permiten
// que los structs estilo Node (`ets_process`) las referencien sin importar el
// orden de aparición en el archivo.
inline double argumentCount();
[[noreturn]] inline void exitProcess(double code) noexcept;

template <typename... Args>
inline void print(const Args&... args) {
    (std::cout << ... << args) << std::endl;
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

// API estilo Node (`console.log`, `console.error`, ...). Por debajo delega en
// print/write (stdout) y printError/writeError (stderr). Las firmas variádicas
// permiten pasar cualquier número de argumentos mezclando tipos.
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

// API estilo Node (`fs.readFileSync`, `fs.writeFile`, ...). Por debajo delega
// en las funciones libres de `runtime/ets_file.hpp`: las versiones `*Sync`
// devuelven `Result<T>` y las versiones async devuelven `Task<Result<T>>`
// (que en el lenguaje fuente se ve como `Promise<Result<T>>`).
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

// API estilo Node (`JSON.stringify`, `JSON.parse`). `JSON.parse` devuelve
// un valor opaco (`ets_json_value`) que el dialecto expone como
// `JsonValue`. El usuario no puede acceder a campos dinámicamente; debe
// usar las funciones helper `ets_json::asString(v)`, `ets_json::asNumber(v)`,
// `ets_json::asArray(v)`, `ets_json::asObject(v)`, `ets_json::get(v, key)`.
// El dialecto no tiene `Object`/`any`/`unknown`, así que este es el camino
// estático para tratar datos JSON dinámicos.
class ets_json_value {
public:
    using Array = std::vector<ets_json_value>;
    using Object = std::map<std::string, ets_json_value>;
    using Storage = std::variant<std::monostate, std::string, double, bool, Array, Object>;
    Storage storage;
    ets_json_value() : storage(std::monostate{}) {}
    ets_json_value(std::string value) : storage(std::move(value)) {}
    ets_json_value(double value) : storage(value) {}
    ets_json_value(bool value) : storage(value) {}
    ets_json_value(Array value) : storage(std::move(value)) {}
    ets_json_value(Object value) : storage(std::move(value)) {}
    bool isNull() const { return std::holds_alternative<std::monostate>(storage); }
    bool isString() const { return std::holds_alternative<std::string>(storage); }
    bool isNumber() const { return std::holds_alternative<double>(storage); }
    bool isBool() const { return std::holds_alternative<bool>(storage); }
    bool isArray() const { return std::holds_alternative<Array>(storage); }
    bool isObject() const { return std::holds_alternative<Object>(storage); }
};

class ets_json_value;

struct ets_json_parser {
    std::size_t pos;
    std::string input;
    std::string error;
    explicit ets_json_parser(const std::string& src) : pos(0), input(src) {}
    static ets_json_value parseValue(const std::string& src) {
        ets_json_parser parser(src);
        ets_json_value value = parser.parseAny();
        if (!parser.error.empty()) return ets_json_value();
        return value;
    }
private:
    void skipWhitespace() {
        while (pos < input.size() && (input[pos] == ' ' || input[pos] == '\t' || input[pos] == '\n' || input[pos] == '\r')) ++pos;
    }
    bool consume(char c) {
        skipWhitespace();
        if (pos < input.size() && input[pos] == c) { ++pos; return true; }
        error = std::string("expected '") + c + "'";
        return false;
    }
    ets_json_value parseAny() {
        skipWhitespace();
        if (pos >= input.size()) { error = "unexpected end of input"; return ets_json_value(); }
        char c = input[pos];
        if (c == '{') return parseObject();
        if (c == '[') return parseArray();
        if (c == '"') return parseString();
        if (c == 't' || c == 'f') return parseBool();
        if (c == 'n') return parseNull();
        return parseNumber();
    }
    ets_json_value parseObject() {
        ets_json_value::Object object;
        if (!consume('{')) return ets_json_value();
        skipWhitespace();
        if (pos < input.size() && input[pos] == '}') { ++pos; return ets_json_value(std::move(object)); }
        while (true) {
            skipWhitespace();
            ets_json_value key = parseString();
            if (!key.isString()) return ets_json_value();
            skipWhitespace();
            if (!consume(':')) return ets_json_value();
            ets_json_value value = parseAny();
            if (!error.empty()) return ets_json_value();
            object.emplace(std::get<std::string>(key.storage), std::move(value));
            skipWhitespace();
            if (pos < input.size() && input[pos] == ',') { ++pos; continue; }
            if (consume('}')) break;
            return ets_json_value();
        }
        return ets_json_value(std::move(object));
    }
    ets_json_value parseArray() {
        ets_json_value::Array array;
        if (!consume('[')) return ets_json_value();
        skipWhitespace();
        if (pos < input.size() && input[pos] == ']') { ++pos; return ets_json_value(std::move(array)); }
        while (true) {
            ets_json_value item = parseAny();
            if (!error.empty()) return ets_json_value();
            array.push_back(std::move(item));
            skipWhitespace();
            if (pos < input.size() && input[pos] == ',') { ++pos; continue; }
            if (consume(']')) break;
            return ets_json_value();
        }
        return ets_json_value(std::move(array));
    }
    ets_json_value parseString() {
        if (!consume('"')) return ets_json_value();
        std::string out;
        while (pos < input.size() && input[pos] != '"') {
            if (input[pos] == '\\' && pos + 1 < input.size()) {
                char esc = input[pos + 1];
                switch (esc) {
                    case '"': out.push_back('"'); break;
                    case '\\': out.push_back('\\'); break;
                    case '/': out.push_back('/'); break;
                    case 'b': out.push_back('\b'); break;
                    case 'f': out.push_back('\f'); break;
                    case 'n': out.push_back('\n'); break;
                    case 'r': out.push_back('\r'); break;
                    case 't': out.push_back('\t'); break;
                    case 'u': out.push_back('?'); pos += 4; break; // simplificado
                    default: error = "invalid escape"; return ets_json_value();
                }
                pos += 2;
            } else { out.push_back(input[pos]); ++pos; }
        }
        if (!consume('"')) return ets_json_value();
        return ets_json_value(std::move(out));
    }
    ets_json_value parseNumber() {
        std::size_t start = pos;
        if (pos < input.size() && (input[pos] == '-' || input[pos] == '+')) ++pos;
        while (pos < input.size() && (std::isdigit(static_cast<unsigned char>(input[pos])) || input[pos] == '.' || input[pos] == 'e' || input[pos] == 'E' || input[pos] == '-' || input[pos] == '+')) ++pos;
        if (start == pos) { error = "expected number"; return ets_json_value(); }
        return ets_json_value(std::stod(input.substr(start, pos - start)));
    }
    ets_json_value parseBool() {
        if (input.compare(pos, 4, "true") == 0) { pos += 4; return ets_json_value(true); }
        if (input.compare(pos, 5, "false") == 0) { pos += 5; return ets_json_value(false); }
        error = "expected boolean";
        return ets_json_value();
    }
    ets_json_value parseNull() {
        if (input.compare(pos, 4, "null") == 0) { pos += 4; return ets_json_value(); }
        error = "expected null";
        return ets_json_value();
    }
};

struct ets_json {
    using Value = ets_json_value;
    using Array = ets_json_value::Array;
    using Object = ets_json_value::Object;
    // API legacy: `parse(input)` devuelve string para JSON escalar.
    static std::string parse(const std::string& input) noexcept {
        ets_json_value value = ets_json_parser::parseValue(input);
        if (value.isString()) return std::get<std::string>(value.storage);
        if (value.isNumber()) {
            std::ostringstream out; out << std::get<double>(value.storage); return out.str();
        }
        if (value.isBool()) return std::get<bool>(value.storage) ? "true" : "false";
        if (value.isNull()) return "null";
        return std::string();
    }
    // API nueva: `parseValue(input)` devuelve el árbol completo.
    static Value parseValue(const std::string& input) noexcept {
        return ets_json_parser::parseValue(input);
    }
    // Stringify recursivo.
    static std::string stringify(const Value& value) {
        return stringifyValue(value.storage);
    }
    // Overloads para tipos primitivos: `JSON.stringify(value)` donde value
    // es string/number/bool/null. Se usan también en el dialecto para los
    // argumentos no-Value de JSON.stringify.
    static std::string stringify(const std::string& value) {
        std::string output; output.reserve(value.size() + 2);
        output.push_back('"');
        for (const unsigned char character : value) {
            switch (character) {
                case '"': output += "\\\""; break;
                case '\\': output += "\\\\"; break;
                case '\b': output += "\\b"; break;
                case '\f': output += "\\f"; break;
                case '\n': output += "\\n"; break;
                case '\r': output += "\\r"; break;
                case '\t': output += "\\t"; break;
                default:
                    if (character < 0x20) {
                        constexpr char hex[] = "0123456789abcdef";
                        output += "\\u00";
                        output += hex[(character >> 4) & 0x0f];
                        output += hex[character & 0x0f];
                    } else output += static_cast<char>(character);
            }
        }
        output.push_back('"');
        return output;
    }
    static std::string stringify(const double value) { std::ostringstream out; out << value; return out.str(); }
    static std::string stringify(const bool value) { return value ? "true" : "false"; }
private:
    static std::string stringifyValue(const ets_json_value::Storage& storage) {
        return std::visit([](auto&& arg) -> std::string {
            using T = std::decay_t<decltype(arg)>;
            if constexpr (std::is_same_v<T, std::monostate>) return "null";
            else if constexpr (std::is_same_v<T, std::string>) {
                std::string output; output.reserve(arg.size() + 2);
                output.push_back('"');
                for (const unsigned char c : arg) {
                    switch (c) {
                        case '"': output += "\\\""; break;
                        case '\\': output += "\\\\"; break;
                        case '\b': output += "\\b"; break;
                        case '\f': output += "\\f"; break;
                        case '\n': output += "\\n"; break;
                        case '\r': output += "\\r"; break;
                        case '\t': output += "\\t"; break;
                        default:
                            if (c < 0x20) {
                                constexpr char hex[] = "0123456789abcdef";
                                output += "\\u00"; output += hex[(c >> 4) & 0x0f]; output += hex[c & 0x0f];
                            } else output += static_cast<char>(c);
                    }
                }
                output.push_back('"');
                return output;
            }
            else if constexpr (std::is_same_v<T, double>) {
                std::ostringstream out; out << arg; return out.str();
            }
            else if constexpr (std::is_same_v<T, bool>) return arg ? "true" : "false";
            else if constexpr (std::is_same_v<T, ets_json_value::Array>) {
                std::string out = "[";
                bool first = true;
                for (const auto& item : arg) { if (!first) out += ","; out += stringifyValue(item.storage); first = false; }
                out += "]";
                return out;
            }
            else if constexpr (std::is_same_v<T, ets_json_value::Object>) {
                std::string out = "{";
                bool first = true;
                for (const auto& [k, v] : arg) { if (!first) out += ","; out += "\"" + k + "\":" + stringifyValue(v.storage); first = false; }
                out += "}";
                return out;
            }
            else return "null";
        }, storage);
    }
};

// Helpers globales expuestas al dialecto. Todas reciben `ets_json_value`
// por valor (es trivialmente copiable) y devuelven el tipo primitivo
// correspondiente. Si el tipo no coincide, se devuelve el valor por defecto.
inline bool jsonIsString(const ets_json_value& v) { return v.isString(); }
inline bool jsonIsNumber(const ets_json_value& v) { return v.isNumber(); }
inline bool jsonIsBool(const ets_json_value& v) { return v.isBool(); }
inline bool jsonIsArray(const ets_json_value& v) { return v.isArray(); }
inline bool jsonIsObject(const ets_json_value& v) { return v.isObject(); }
inline bool jsonIsNull(const ets_json_value& v) { return v.isNull(); }
inline std::string jsonAsString(const ets_json_value& v) { return v.isString() ? std::get<std::string>(v.storage) : std::string(); }
inline double jsonAsNumber(const ets_json_value& v) { return v.isNumber() ? std::get<double>(v.storage) : 0.0; }
inline bool jsonAsBool(const ets_json_value& v) { return v.isBool() ? std::get<bool>(v.storage) : false; }
inline std::size_t jsonArrayLength(const ets_json_value& v) { return v.isArray() ? std::get<ets_json_value::Array>(v.storage).size() : 0; }
inline ets_json_value jsonArrayGet(const ets_json_value& v, std::size_t index) {
    if (!v.isArray() || index >= std::get<ets_json_value::Array>(v.storage).size()) return ets_json_value();
    return std::get<ets_json_value::Array>(v.storage)[index];
}
inline ets_json_value jsonObjectGet(const ets_json_value& v, const std::string& key) {
    if (!v.isObject()) return ets_json_value();
    const auto& object = std::get<ets_json_value::Object>(v.storage);
    auto it = object.find(key);
    return it != object.end() ? it->second : ets_json_value();
}
inline std::vector<std::string> jsonObjectKeys(const ets_json_value& v) {
    std::vector<std::string> keys;
    if (!v.isObject()) return keys;
    for (const auto& [k, _] : std::get<ets_json_value::Object>(v.storage)) keys.push_back(k);
    return keys;
}

inline ets_json JSON{};

// `Math` (Bloque E): operaciones numéricas básicas sobre `double` que
// envuelven `<cmath>` con una API ergonómica estilo TypeScript. Todas las
// funciones son estáticas (`ets_math::floor(x)`) y se exponen como globales
// `Math.floor(x)` en el lenguaje fuente. No hay funciones que dependan de
// `Object`/`any` (p.ej. `Math.max` con número variable de argumentos solo
// soporta 2 argumentos por la restricción de variadics del dialecto).
struct ets_math {
    static double floor(const double value) noexcept { return std::floor(value); }
    static double ceil(const double value) noexcept { return std::ceil(value); }
    static double round(const double value) noexcept { return std::round(value); }
    static double abs(const double value) noexcept { return std::fabs(value); }
    static double sqrt(const double value) noexcept { return std::sqrt(value); }
    static double pow(const double base, const double exponent) noexcept { return std::pow(base, exponent); }
    static double min(const double left, const double right) noexcept { return left < right ? left : right; }
    static double max(const double left, const double right) noexcept { return left > right ? left : right; }
};

inline ets_math Math{};

// `Date` (Bloque E): API mínima estilo JavaScript para tiempo. El dialecto
// no tiene zona horaria dinámica ni objetos fecha mutables (eso requeriría
// `Object`). Solo se exponen constructores y accesores que devuelven números
// primitivos (`number` en etsc).
struct ets_date {
    static double now() noexcept {
        return static_cast<double>(std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count());
    }
    // `Date.UTC(year, month, day, ...)` devuelve el timestamp UTC en ms. Se
    // toman 3 argumentos posicionales (no se admiten tuplas): año, mes 0-11,
    // día 1-31. Coherente con la API estándar.
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

inline bool ensureParentDirectory(const std::string& path, std::string& error) noexcept {
    std::error_code status;
    const auto parent = std::filesystem::path(path).parent_path();
    if (!parent.empty()) std::filesystem::create_directories(parent, status);
    if (status) { error = "No se puede crear el directorio de salida: " + status.message(); return false; }
    return true;
}

inline bool fail(const std::string& message, std::string& error) noexcept {
    error = message;
    return false;
}

inline void clearError(std::string& error) noexcept { error.clear(); }
inline bool hasError(const std::string& error) noexcept { return !error.empty(); }

inline double argumentCount() { return static_cast<double>(ets_argc); }

[[noreturn]] inline void exitProcess(double code) noexcept {
    std::exit(static_cast<int>(code));
}

inline std::string jsonEscape(const std::string& value) {
    std::string output;
    output.reserve(value.size());
    constexpr char hex[] = "0123456789abcdef";
    for (const unsigned char character : value) {
        switch (character) {
            case '\"': output += "\\\""; break;
            case '\\': output += "\\\\"; break;
            case '\b': output += "\\b"; break;
            case '\f': output += "\\f"; break;
            case '\n': output += "\\n"; break;
            case '\r': output += "\\r"; break;
            case '\t': output += "\\t"; break;
            default:
                if (character < 0x20) {
                    output += "\\u00";
                    output += hex[(character >> 4) & 0x0f];
                    output += hex[character & 0x0f];
                } else output += static_cast<char>(character);
        }
    }
    return output;
}

inline std::string argument(double index) {
    const auto i = static_cast<int>(index);
    return i >= 0 && i < ets_argc ? std::string(ets_argv[i]) : std::string();
}

inline std::string normalizePath(const std::string& path) {
    std::error_code error;
    const auto absolute = std::filesystem::absolute(std::filesystem::path(path), error);
    return (error ? std::filesystem::path(path) : absolute).lexically_normal().string();
}

inline std::string compilerRoot() {
    std::filesystem::path runtimeHeader(__FILE__);
    if (runtimeHeader.is_relative()) runtimeHeader = std::filesystem::absolute(runtimeHeader);
    return runtimeHeader.parent_path().parent_path().lexically_normal().string();
}

inline std::string resolveImportPath(const std::string& importer, const std::string& specifier) {
    std::filesystem::path requested(specifier);
    if (requested.is_relative()) requested = std::filesystem::path(importer).parent_path() / requested;
    if (!requested.has_extension()) {
        std::filesystem::path typescript = requested; typescript += ".ts";
        std::error_code status;
        if (std::filesystem::is_regular_file(typescript, status) && !status) requested = std::move(typescript);
        else { requested += ".ets"; }
    }
    return normalizePath(requested.string());
}

inline std::string pathDirectory(const std::string& path) {
    return std::filesystem::path(normalizePath(path)).parent_path().string();
}

inline std::string resolveProjectPath(const std::string& configFile, const std::string& value) {
    const std::filesystem::path requested(value);
    return normalizePath((requested.is_absolute() ? requested : std::filesystem::path(configFile).parent_path() / requested).string());
}
