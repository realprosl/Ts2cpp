// V7: helpers de colecciones (`filter`, `map`, `reduce`) sobre `std::vector<T>`.
//
// El dialecto no soporta métodos sobre tipos genéricos parametrizados como
// `T[]` (no hay `arr.filter(p)` directamente — el método se reescribe en el
// codegen a una llamada a uno de estos helpers). Cada helper se modela como
// plantilla C++ con dos parámetros: el tipo de elemento y el functor (lambda
// o `std::function`). Así el caller no paga indirección de `std::function`
// si pasa una lambda inline.
//
// API expuesta (en el namespace global para que el codegen pueda emitir las
// llamadas directamente sin lookup de namespace):
//   ets_filter_vec<T>(src, pred)    → std::vector<T>
//   ets_map_vec<T, U>(src, f)       → std::vector<U>
//   ets_reduce<U, T>(init, src, op) → U
//
// V7.1 (issue #40, fusión AST) reescribirá las cadenas `filter → map →
// reduce` a un único `for`; V7.0 emite la llamada directa a estos helpers
// con semántica clara (orden estable, side-effects en orden, init se
// respeta incluso si el vector está vacío).

#pragma once

#include <cstddef>
#include <functional>
#include <utility>
#include <vector>

// `ets_filter_vec<T>(src, pred)` — versión plantilla que acepta cualquier
// callable compatible con `bool(const T&)` (incluye lambdas `[=](const T&) -> bool`).
// Evita la sobrecarga de `std::function` cuando el caller pasa una lambda
// inline. La firma con `std::function<bool(const T&)>` también se acepta
// por conversión implícita.
template <typename T, typename Pred>
inline std::vector<T> ets_filter_vec(const std::vector<T>& src, Pred&& pred) {
    std::vector<T> out;
    out.reserve(src.size());
    for (const auto& item : src) {
        if (pred(item)) out.push_back(item);
    }
    return out;
}

// Overload para `std::function` explícito (legibilidad cuando el caller
// guarda el predicado en una variable de tipo `std::function`).
template <typename T>
inline std::vector<T> ets_filter_vec(const std::vector<T>& src, const std::function<bool(const T&)>& pred) {
    return ets_filter_vec<T, std::function<bool(const T&)>>(src, pred);
}

// `ets_map_vec<T, U>(src, f)` — aplica `f` a cada elemento y devuelve un
// `std::vector<U>`. El parámetro `T` es deducible del `src`; `U` debe
// poder deducirse del tipo de retorno de `f` (`auto`).
template <typename T, typename U, typename F>
inline std::vector<U> ets_map_vec(const std::vector<T>& src, F&& f) {
    std::vector<U> out;
    out.reserve(src.size());
    for (const auto& item : src) {
        out.push_back(f(item));
    }
    return out;
}

// Overload para `std::function` explícito.
template <typename T, typename U>
inline std::vector<U> ets_map_vec(const std::vector<T>& src, const std::function<U(const T&)>& f) {
    return ets_map_vec<T, U, std::function<U(const T&)>>(src, f);
}

// `ets_reduce<U, T>(init, src, op)` — pliega `src` con `op` desde `init`.
// `U` es el tipo del acumulador, `T` el del elemento; ambos se deducen de
// los argumentos. Si `src` está vacío, devuelve `init` sin invocar `op`.
template <typename U, typename T, typename Op>
inline U ets_reduce(U init, const std::vector<T>& src, Op&& op) {
    U acc = init;
    for (const auto& item : src) {
        acc = op(acc, item);
    }
    return acc;
}

// Overload para `std::function` explícito (útil cuando el operator se
// guarda en una variable capturada).
template <typename U, typename T>
inline U ets_reduce(U init, const std::vector<T>& src, const std::function<U(const U&, const T&)>& op) {
    return ets_reduce<U, T, std::function<U(const U&, const T&)>>(init, src, op);
}

// V11: `ets_for_each_vec<T>(src, fn)` — aplica `fn` a cada elemento
// sin producir resultado. Equivalente a `for (auto& item : src) fn(item)`.
template <typename T, typename F>
inline void ets_for_each_vec(const std::vector<T>& src, F&& fn) {
    for (const auto& item : src) fn(item);
}

// V13: `ets_find_vec<T>(src, pred)` — devuelve `Optional<T>` con el
// primer elemento que cumple `pred`, o vacío si ninguno. El usuario
// discrimina con `?.`, `match` o `value()` (que aborta si vacío).
template <typename T, typename Pred>
inline ets::Optional<T> ets_find_vec(const std::vector<T>& src, Pred&& pred) {
    for (const auto& item : src) if (pred(item)) return ets::Optional<T>::some(item);
    return ets::Optional<T>::none();
}

// V11: `ets_some_vec<T>(src, pred)` — true si AL MENOS UN elemento cumple `pred`.
template <typename T, typename Pred>
inline bool ets_some_vec(const std::vector<T>& src, Pred&& pred) {
    for (const auto& item : src) if (pred(item)) return true;
    return false;
}

// V11: `ets_every_vec<T>(src, pred)` — true si TODOS los elementos cumplen `pred`.
// (Vacío → true, convención JS.)
template <typename T, typename Pred>
inline bool ets_every_vec(const std::vector<T>& src, Pred&& pred) {
    for (const auto& item : src) if (!pred(item)) return false;
    return true;
}

// V11: `ets_slice_vec<T>(src, start, end)` — sub-array desde `start`
// (inclusivo) hasta `end` (exclusivo). Índices negativos se cuentan
// desde el final (al estilo JS): -1 = último elemento, -2 = penúltimo.
template <typename T>
inline std::vector<T> ets_slice_vec(const std::vector<T>& src, int start, int end) {
    const int n = static_cast<int>(src.size());
    if (start < 0) start = std::max(0, n + start);
    if (end < 0) end = n + end;
    if (start >= n || start >= end) return {};
    if (end > n) end = n;
    return std::vector<T>(src.begin() + start, src.begin() + end);
}