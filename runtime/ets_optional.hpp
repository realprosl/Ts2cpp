// `ets::Optional<T>` — envoltura de `std::optional<T>` con API ergonómica
// estilo TypeScript/Rust.
//
// El dialecto no tiene `null`/`undefined`, así que la ausencia se modela
// con `Optional<T>` (que internamente usa `std::optional`). Esto desbloquea
// `??` (nullish coalescing) y `?.` (optional chaining) en el dialecto.
//
// API:
//   isPresent()         → bool
//   valueOr(default)    → T
//   map(f)              → Optional<U>          (f: T → U)
//   andThen(f)          → Optional<U>          (f: T → Optional<U>)
//   orElse(other)       → Optional<T>          (si vacío, devuelve other)
//
// Construcción:
//   ets::Optional<T>::some(value)
//   ets::Optional<T>::none()
//   ets::Optional<T>::of(optional<T>)         (wrapper de std::optional)

#pragma once
#include <optional>
#include <functional>
#include <type_traits>
#include <utility>

namespace ets {
template <typename T>
class Optional {
public:
    Optional() : storage_() {}                                  // None
    Optional(const T& value) : storage_(value) {}               // Some(value)
    Optional(T&& value) : storage_(std::move(value)) {}         // Some(move)
    static Optional some(const T& value) { return Optional(value); }
    static Optional some(T&& value) { return Optional(std::move(value)); }
    static Optional none() { return Optional(); }
    template <typename U>
    static Optional of(const std::optional<U>& opt) {
        if (opt.has_value()) return Optional(*opt);
        return Optional();
    }
    bool isPresent() const noexcept { return storage_.has_value(); }
    bool isEmpty() const noexcept { return !storage_.has_value(); }
    const T& value() const { return storage_.value(); }
    T valueOr(const T& defaultValue) const { return storage_.value_or(defaultValue); }
    template <typename F>
    auto map(F&& f) const -> Optional<decltype(f(std::declval<T>()))> {
        if (storage_.has_value()) return Optional<decltype(f(std::declval<T>()))>(f(*storage_));
        return Optional<decltype(f(std::declval<T>()))>::none();
    }
    template <typename F>
    auto andThen(F&& f) const -> typename std::decay_t<decltype(f(std::declval<T>()))> {
        using Return = typename std::decay_t<decltype(f(std::declval<T>()))>;
        if (storage_.has_value()) return f(*storage_);
        return Return::none();
    }
    Optional<T> orElse(const Optional<T>& other) const {
        return storage_.has_value() ? *this : other;
    }
    // Operador == para comparaciones (necesario para tests).
    bool operator==(const Optional& other) const { return storage_ == other.storage_; }
    bool operator!=(const Optional& other) const { return storage_ != other.storage_; }
private:
    std::optional<T> storage_;
};
}

// Constructor explícito para `None`.
template <typename T>
inline ets::Optional<T> makeNone() { return ets::Optional<T>::none(); }

template <typename T>
inline ets::Optional<T> makeSome(const T& value) { return ets::Optional<T>::some(value); }

template <typename T>
inline ets::Optional<T> makeSome(T&& value) { return ets::Optional<T>::some(std::forward<T>(value)); }

// Helpers globales estilo TypeScript para `Optional<T>`. El dialecto no
// soporta métodos sobre tipos genéricos (`Optional<T>.some(...)` no se
// puede escribir todavía), así que se exponen como funciones libres.
// Cada helper preserva el tipo genérico a través de la firma del
// type-checker del dialecto (que infiere T del contexto).
template <typename T>
inline ets::Optional<T> optionalSome(const T& value) { return ets::Optional<T>::some(value); }

template <typename T>
inline ets::Optional<T> optionalNone() { return ets::Optional<T>::none(); }

template <typename T>
inline bool optionalIsPresent(const ets::Optional<T>& opt) { return opt.isPresent(); }

template <typename T>
inline T optionalValueOr(const ets::Optional<T>& opt, const T& defaultValue) { return opt.valueOr(defaultValue); }

template <typename T, typename F>
inline auto optionalMap(const ets::Optional<T>& opt, F&& f) {
    return opt.map(std::forward<F>(f));
}

template <typename T, typename F>
inline auto optionalAndThen(const ets::Optional<T>& opt, F&& f) {
    return opt.andThen(std::forward<F>(f));
}

template <typename T>
inline ets::Optional<T> optionalOrElse(const ets::Optional<T>& opt, const ets::Optional<T>& other) {
    return opt.orElse(other);
}
