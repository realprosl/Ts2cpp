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
#include <initializer_list>
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

// V14: `ets_slice_vec<T>(src, start, end)` — sub-array desde `start`
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

// V14: `ets_sort_vec<T>(src, cmp)` — ordena `src` in-place con `cmp(a, b)`
// y devuelve el mismo vector. El dialecto emite esto para `arr.sort(cmp)`.
//
// Importante: el comparator debe implementar **strict weak ordering**.
// Comparadores como `(a, b) => a - b` son **incorrectos** para `double`
// porque la resta puede dar ±0.0 para valores iguales (rompe transitividad
// y el comportamiento de `std::sort` es indefinido en ese caso). Para
// hacerlo seguro, el runtime envuelve el comparator devuelto por el
// usuario en un adaptador que:
//   - si el comparator ya devuelve bool, lo usa tal cual (caso ideal);
//   - si devuelve un número, lo convierte a `r < 0` (orden por signo).
// Esto es seguro para enteros, floats y doubles: para dobles iguales
// `r == 0`, lo que da `false < 0 == false`, equivalente a `!(b < a)`,
// manteniendo strict weak ordering (a == b → !(a < b) && !(b < a)).
template <typename T, typename Cmp>
inline std::vector<T>& ets_sort_vec(std::vector<T>& src, Cmp&& cmp) {
    using R = std::invoke_result_t<Cmp, const T&, const T&>;
    if constexpr (std::is_same_v<R, bool>) {
        std::sort(src.begin(), src.end(), std::forward<Cmp>(cmp));
    } else {
        // Adaptador: cualquier R convertible a bool (típicamente number)
        // se evalúa como `r < 0` (orden ascendente por signo de la resta).
        std::sort(src.begin(), src.end(), [c = std::forward<Cmp>(cmp)](const T& a, const T& b) -> bool {
            return c(a, b) < 0;
        });
    }
    return src;
}

// V14: `ets_flat_map_vec<T, U>(src, f)` — aplica `f` (que devuelve vector)
// y concatena los resultados en un solo vector (1 nivel de flattening).
template <typename T, typename U, typename F>
inline std::vector<U> ets_flat_map_vec(const std::vector<T>& src, F&& f) {
    std::vector<U> out;
    for (const auto& item : src) {
        auto inner = f(item);
        for (auto& v : inner) out.push_back(std::move(v));
    }
    return out;
}

// V14: `ets_includes_vec<T>(src, value)` — true si `value` está en `src`.
// Usa `operator==` sobre T (las clases la definen explícitamente).
template <typename T>
inline bool ets_includes_vec(const std::vector<T>& src, const T& value) {
    for (const auto& item : src) if (item == value) return true;
    return false;
}

// V30.8: `ets_concat_vec<T>({a, b, c, ...})` — une N arrays en uno nuevo.
// Variadico: acepta std::initializer_list<std::vector<T>> para no tener
// que enumerar N overloads. Devuelve un nuevo vector por valor (1 malloc
// del buffer resultante). Mismo criterio que `slice` y `map` mientras el
// dialecto siga modelando arrays por valor.
template <typename T>
inline std::vector<T> ets_concat_vec(std::initializer_list<std::vector<T>> arrays) {
    std::vector<T> out;
    std::size_t total = 0;
    for (const auto& a : arrays) total += a.size();
    out.reserve(total);
    for (const auto& a : arrays) {
        for (const auto& v : a) out.push_back(v);
    }
    return out;
}

// V30.13.2: `ets_push_vec<T>(vec, value)` — añade un elemento al final
// de un vector. Acepta `std::vector<T>&` (no const) y hace `push_back`.
// Equivalente a `arr.push(x)` en el dialecto. Devuelve void (no
// devolvemos el nuevo length porque el dialecto no lo usa).
template <typename T>
inline void ets_push_vec(std::vector<T>& vec, const T& value) {
    vec.push_back(value);
}

// V30.55: `ets_set_vec<T>(vec, index, value)` — asignación indexada
// con auto-resize. Equivalente a `arr[i] = x` en el dialecto, pero
// seguro cuando `i >= vec.size()` (hace resize en vez de OOB).
// Acepta índices double (como todo en el dialecto) y los trunca a
// `size_t`. El dialecto compila con `-fno-exceptions`, así que
// índices negativos se ignoran (truncados a un valor enorme y
// resize — limitation documentada).
template <typename T>
inline void ets_set_vec(std::vector<T>& vec, double index, const T& value) {
    auto i = index < 0 ? 0 : static_cast<size_t>(index);
    if (i >= vec.size()) vec.resize(i + 1);
    vec[i] = value;
}

// V30.13.2: `ets_pop_vec<T>(vec)` — elimina el último elemento del
// vector. No devuelve el valor (el dialecto no lo necesita; los usuarios
// que necesiten el valor usan `arr[arr.length - 1]` antes de pop).
template <typename T>
inline void ets_pop_vec(std::vector<T>& vec) {
    if (!vec.empty()) vec.pop_back();
}

// V30.24: `ets_join_vec<T>(vec, separator)` — une los elementos del
// vector `vec` en un `std::string`, separados por `separator`. Equivalente
// a `arr.join(sep)` en el dialecto. Para `T = std::string` se usa
// `operator+`; para otros tipos el usuario debe asegurarse de que
// `operator<<` este definido (limitation documentada: el type-checker
// solo valida `T = string`; el codegen no fuerza el tipo en el template).
inline std::string ets_join_vec(const std::vector<std::string>& vec, const std::string& separator) {
    std::string out;
    for (std::size_t i = 0; i < vec.size(); ++i) {
        if (i > 0) out += separator;
        out += vec[i];
    }
    return out;
}