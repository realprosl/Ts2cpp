// `ets::Mut<T>` — puntero mutable no-owning (`T* const` en C++).
//
// El dialecto modela "puntero crudo mutable" con `Mut<T>`. Por convención,
// el puntero es CONSTANTE (no se puede reasignar a otro objeto) pero el
// CONTENIDO apuntado es mutable. Esto evita los bugs clásicos de "moví el
// puntero y dejé dangling references" — el dialecto sigue Rust en esto.
//
// Reglas del dialecto:
// - `Mut<T>` se usa para punteros opacos o acceso de bajo nivel.
// - `Mut<T>` solo aplica a objetos (T no es primitivo). Los primitivos van
//   siempre por valor.
// - Preferir `MutRef<T>` o `Un<T>` cuando sea posible; `Mut<T>` es la opción
//   "unsafe" estilo C.
//
// API:
//   value()         → T&
//   value() const   → const T&
//   operator->()    → T*
//   raw()           → T* (escape hatch a C++ puro)
//
// Helpers globales:
//   mutOf<T>(ptr)            → Mut<T>
//   mutFrom<T>(lvalue)       → Mut<T>  (toma la dirección de un lvalue)

#pragma once
#include <type_traits>

namespace ets {

template <typename T>
class Mut {
public:
    // Constructor desde puntero crudo.
    explicit Mut(T* ptr) : storage_(ptr) {}

    // Copy: el puntero se copia (apunta al mismo objeto).
    Mut(const Mut&) = default;
    Mut& operator=(const Mut&) = default;

    // Predicados.
    bool isSome() const noexcept { return storage_ != nullptr; }
    bool isNone() const noexcept { return storage_ == nullptr; }

    // Acceso al valor. Pre: storage_ != nullptr (a diferencia de MutRef,
    // aquí permitimos nullptr porque es la opción unsafe).
    T& value() const { return *storage_; }
    T* operator->() const { return storage_; }
    T& operator*() const { return *storage_; }

    // Escape hatch.
    T* raw() const { return storage_; }

private:
    T* storage_;  // T* const — el puntero no se reasigna, pero *storage_ es mutable
};

} // namespace ets

// Helpers globales estilo "optionalSome".
template <typename T>
inline ets::Mut<T> mutOf(T* ptr) {
    return ets::Mut<T>(ptr);
}

template <typename T>
inline ets::Mut<T> mutFrom(T& lvalue) {
    return ets::Mut<T>(&lvalue);
}

template <typename T>
inline T& mutValue(const ets::Mut<T>& m) {
    return m.value();
}

template <typename T>
inline bool mutIsSome(const ets::Mut<T>& m) {
    return m.isSome();
}
