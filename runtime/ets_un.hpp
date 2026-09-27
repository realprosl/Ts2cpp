// `ets::Un<T>` — envoltura de `std::unique_ptr<T>` para ownership único.
//
// El dialecto modela "ownership único" con `Un<T>` (siguiendo la nomenclatura
// de smart pointers de C++). Es move-only: no se puede copiar. Al salir del
// scope, el destructor libera automáticamente el recurso (RAII del dialecto).
//
// Por diseño del dialecto:
// - `Un<T>` solo aplica a objetos (T no es primitivo). Los primitivos van
//   siempre por valor.
// - `Un<T>` no expone nullptr al usuario; o tiene valor o se construye con
//   `Un.none<T>()`.
//
// API:
//   isSome()         → bool
//   isNone()         → bool
//   value()          → T&
//   value() const    → const T&
//   operator->()     → T* (para acceso a miembros)
//   release()        → T* (transfiere ownership, devuelve puntero crudo)
//   reset(newPtr)    → reemplaza el recurso (libera el viejo)
//
// Construcción:
//   ets::Un<T>::some(value)        — std::unique_ptr<T>(new T(value))
//   ets::Un<T>::none()            — std::unique_ptr<T>(nullptr)
//
// Helpers globales (siguen el patrón de `optionalSome`):
//   unSome<T>(value)              → Un<T>
//   unNone<T>()                   → Un<T>
//
// Diferencias con `MutRef<T>` (alias mutable) y `Mut<T>` (puntero crudo):
//   Un<T>     = std::unique_ptr<T>  (owning, move-only)
//   MutRef<T> = T&                   (alias, mismo lifetime)
//   Mut<T>    = T* const             (puntero crudo no-owning, no reasignable)
//   Rc<T>     = std::shared_ptr<T>  (owning, ref-counted)

#pragma once
#include <memory>
#include <utility>
#include <type_traits>

namespace ets {

template <typename T>
class Un {
public:
    // Construcción desde puntero (toma ownership).
    explicit Un(T* ptr) : storage_(ptr) {}

    // Move constructor.
    Un(Un&& other) noexcept : storage_(std::move(other.storage_)) {}

    // Sin copy constructor (move-only, como std::unique_ptr).
    Un(const Un&) = delete;
    Un& operator=(const Un&) = delete;

    // Move assignment.
    Un& operator=(Un&& other) noexcept {
        storage_ = std::move(other.storage_);
        return *this;
    }

    // Fábricas estáticas.
    static Un some(T value) {
        return Un(new T(std::move(value)));
    }
    static Un none() {
        return Un(static_cast<T*>(nullptr));
    }

    // Predicados.
    bool isSome() const noexcept { return storage_ != nullptr; }
    bool isNone() const noexcept { return storage_ == nullptr; }

    // Acceso al valor. Pre: isSome().
    T& value() & { return *storage_; }
    const T& value() const & { return *storage_; }
    T* operator->() { return storage_.get(); }
    const T* operator->() const { return storage_.get(); }
    T& operator*() & { return *storage_; }
    const T& operator*() const & { return *storage_; }

    // Transferencia de ownership (devuelve el puntero crudo, deja Un vacío).
    T* release() noexcept { return storage_.release(); }

    // Reemplazo (libera el anterior si lo hay).
    void reset(T* newPtr = nullptr) { storage_.reset(newPtr); }

private:
    std::unique_ptr<T> storage_;
};

} // namespace ets

// Helpers globales estilo "optionalSome" / "optionalNone".
template <typename T>
inline ets::Un<T> unSome(T value) {
    return ets::Un<T>::some(std::move(value));
}

template <typename T>
inline ets::Un<T> unNone() {
    return ets::Un<T>::none();
}

template <typename T>
inline bool unIsSome(const ets::Un<T>& u) {
    return u.isSome();
}

template <typename T>
inline const T& unValue(const ets::Un<T>& u) {
    return u.value();
}
