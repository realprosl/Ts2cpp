#pragma once

// V16: runtime ultra-mínimo. Igual que `ets_runtime.hpp` pero sin
// `ets_io.hpp` (print, console, Math, Date). Solo expone Map/Set, JSON, y
// los primitives del compilador. Pensado para progrfiles con `--minimal`
// cuando el usuario quiere un binario final sin helpers de IO.
//
// El programa es responsable de:
//   - Incluir `<iostream>` si quiere `std::cout`
//   - Incluir `runtime/ets_io.hpp` si quiere `print`/`console.log`
//   - Definir sus propios helpers de output

#include <cstddef>
#include <cstdlib>
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
// V16: NO incluye `runtime/ets_io.hpp` (print/console/Math/Date).
#include "runtime/ets_string.hpp"
#include "runtime/ets_optional.hpp"
#include "runtime/ets_unq.hpp"
#include "runtime/ets_rc.hpp"

namespace std {
template <typename... Types> requires (sizeof...(Types) > 0)
inline std::ostream& operator<<(std::ostream& stream, const std::variant<Types...>& value) {
    std::visit([&stream](const auto& inner) { stream << inner; }, value);
    return stream;
}
} // namespace std

namespace ets {

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

// JSON (igual que en ets_runtime.hpp)
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

inline ets_json JSON{};

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

struct ets_json {
    using Value = ets_json_value;
    using Array = ets_json_value::Array;
    using Object = ets_json_value::Object;
    static std::string parse(const std::string&) noexcept { return std::string(); }
    static Value parseValue(const std::string& input) noexcept { return ets_json_value(); }
    static std::string stringify(const Value&) { return std::string(); }
    static std::string stringify(const std::string& value) { return value; }
    static std::string stringify(const double value) { return std::to_string(value); }
    static std::string stringify(const bool value) { return value ? "true" : "false"; }
};
inline ets_json JSON{};
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