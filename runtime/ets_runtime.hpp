#pragma once

// V16: runtime mínimo. Solo contiene lo que NO requiere otros headers
// runtime: tipos básicos, helpers globales, Map<K,V>, Set<T>, JSON.
//
// El resto (filesystem, async, net, process, path, struct ets_filesystem,
// struct ets_process, etc.) vive en `ets_runtime_full.hpp` y se incluye
// bajo demanda desde el codegen. El codegen detecta con un visitor si el
// programa usa alguno de esos símbolos (`fs.readFileSync`, `process.argv`,
// `JSON.stringify`, `path.join`, etc.) y solo entonces incluye el header
// completo. Para programas que solo usan `print`/`Map`/`Set`, este header
// basta.

#include <cstddef>
#include <cstdlib>
#include <cctype>
#include <filesystem>
#include <iostream>
#include <map>
#include <optional>
#include <sstream>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <variant>
#include <vector>
#include "runtime/ets_core.hpp"
#include "runtime/ets_io.hpp"
#include "runtime/ets_string.hpp"
#include "runtime/ets_optional.hpp"
#include "runtime/ets_unq.hpp"
#include "runtime/ets_rc.hpp"

namespace std {
// `operator<<` para `std::variant`: imprime el valor activo.
template <typename... Types> requires (sizeof...(Types) > 0)
inline std::ostream& operator<<(std::ostream& stream, const std::variant<Types...>& value) {
    std::visit([&stream](const auto& inner) { stream << inner; }, value);
    return stream;
}
} // namespace std

namespace ets {

// `Map<K, V>` estilo JavaScript envuelto sobre `std::unordered_map`.
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
    template <typename F>
    void forEach(F&& fn) const {
        for (const auto& pair : data_) fn(pair.second, pair.first);
    }
    const std::unordered_map<K, V>& data() const { return data_; }
};

// `Set<T>` estilo JavaScript sobre `std::unordered_set`.
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

} // namespace ets

// JSON API (estilo Node). NO requiere ets_async ni ets_file.
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
                    case '\b': out.push_back('\b'); break;
                    case '\f': out.push_back('\f'); break;
                    case '\n': out.push_back('\n'); break;
                    case '\r': out.push_back('\r'); break;
                    case '\t': out.push_back('\t'); break;
                    case 'u': out.push_back('?'); pos += 4; break;
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
    static Value parseValue(const std::string& input) noexcept {
        return ets_json_parser::parseValue(input);
    }
    static std::string stringify(const Value& value) {
        return stringifyValue(value.storage);
    }
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
                constexpr char hex[] = "0123456789abcdef";
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

inline std::string jsonEscape(const std::string& value) {
    std::string output;
    output.reserve(value.size());
    constexpr char hex[] = "0123456789abcdef";
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
                    output += "\\u00";
                    output += hex[(character >> 4) & 0x0f];
                    output += hex[character & 0x0f];
                } else output += static_cast<char>(character);
        }
    }
    return output;
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