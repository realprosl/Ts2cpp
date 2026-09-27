// `ets::Rc<T>` — envoltura de `std::shared_ptr<T>` para ownership compartido.
//
// El dialecto modela "conteo de referencias" con `Rc<T>`. Es copiable (cada
// copia incrementa el contador de referencias). Al destruirse la última
// referencia, el recurso se libera.
//
// Por diseño del dialecto:
// - `Rc<T>` solo aplica a objetos (T no es primitivo). Los primitivos van
//   siempre por valor.
// - El dialecto no permite ciclos de referencias (no hay Weak equivalente);
//   `LIMITATIONS.md` lo documenta. Para diagnóstico: `Rc::strongCount(rc)`.
//
// API:
//   strongCount(rc)  → int (cuántas Rc<T> comparten el recurso)
//   isSome()         → bool
//   isNone()         → bool
//   value()          → T&
//   value() const    → const T&
//   operator->()     → T*
//
// Construcción:
//   ets::Rc<T>::share(value)        — std::shared_ptr<T>(new T(value))
//   ets::Rc<T>::sharePtr(ptr)      — desde std::shared_ptr ya existente
//
// Helpers globales:
//   rcShare<T>(value)               → Rc<T>

#pragma once
#include <memory>
#include <utility>
#include <type_traits>

namespace ets {

template <typename T>
class Rc {
public:
    // Construcción desde puntero (toma ownership compartido).
    explicit Rc(T* ptr) : storage_(ptr) {}

    // Copy.
    Rc(const Rc& other) : storage_(other.storage_) {}
    Rc& operator=(const Rc& other) {
        storage_ = other.storage_;
        return *this;
    }

    // Move.
    Rc(Rc&& other) noexcept : storage_(std::move(other.storage_)) {}
    Rc& operator=(Rc&& other) noexcept {
        storage_ = std::move(other.storage_);
        return *this;
    }

    // Fábricas estáticas.
    static Rc share(T value) {
        return Rc(new T(std::move(value)));
    }
    static Rc sharePtr(std::shared_ptr<T> ptr) {
        Rc r(static_cast<T*>(nullptr));
        r.storage_ = std::move(ptr);
        return r;
    }

    // Conteo de referencias fuertes.
    int strongCount() const noexcept { return static_cast<int>(storage_.use_count()); }

    // Predicados.
    bool isSome() const noexcept { return storage_ != nullptr; }
    bool isNone() const noexcept { return storage_ == nullptr; }

    // Acceso al valor.
    T& value() & { return *storage_; }
    const T& value() const & { return *storage_; }
    T* operator->() { return storage_.get(); }
    const T* operator->() const { return storage_.get(); }
    T& operator*() & { return *storage_; }
    const T& operator*() const & { return *storage_; }

    // Acceso al shared_ptr subyacente (para interoperabilidad).
    std::shared_ptr<T>& shared() { return storage_; }
    const std::shared_ptr<T>& shared() const { return storage_; }

private:
    std::shared_ptr<T> storage_;
};

} // namespace ets

// Helper global estilo "optionalSome".
template <typename T>
inline ets::Rc<T> rcShare(T value) {
    return ets::Rc<T>::share(std::move(value));
}

template <typename T>
inline int rcStrongCount(const ets::Rc<T>& r) {
    return r.strongCount();
}

template <typename T>
inline T& rcValue(ets::Rc<T>& r) {
    return r.value();
}
