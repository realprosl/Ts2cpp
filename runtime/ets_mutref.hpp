// `ets::MutRef<T>` — alias mutable (`T&` en C++).
//
// El dialecto modela "referencia mutable" con `MutRef<T>`. Es un alias: el
// recurso lo posee otro, `MutRef<T>` solo presta acceso mutable al mismo.
// En C++ se traduce literalmente a `T&`.
//
// Reglas del dialecto:
// - `MutRef<T>` se usa principalmente en parámetros de función para evitar
//   copias y permitir mutación del objeto del caller.
// - `MutRef<T>` solo aplica a objetos (T no es primitivo). Los primitivos
//   van siempre por valor.
// - El lifetime está implícitamente limitado por el scope donde se creó
//   (no hay anotación de lifetime explícita, como en Rust).
//
// API (mínima, porque es un alias):
//   get()         → T& (acceso crudo al subyacente)
//   operator*()   → T&
//   operator->()  → T*
//
// Helpers globales:
//   mutRefOf<T>(ref)         → MutRef<T>
//   mutRefFrom<T>(lvalue)    → MutRef<T>

#pragma once
#include <utility>
#include <type_traits>

namespace ets {

template <typename T>
class MutRef {
public:
    // Constructor desde referencia lvalue (toma la dirección).
    explicit MutRef(T& ref) : storage_(&ref) {}

    // No copy: una referencia no se copia, se rebind.
    MutRef(const MutRef&) = default;
    MutRef& operator=(const MutRef&) = default;

    // Acceso al valor.
    T& value() const { return *storage_; }
    T* operator->() const { return storage_; }
    T& operator*() const { return *storage_; }

private:
    T* storage_;
};

} // namespace ets

// Helpers globales estilo "optionalSome".
template <typename T>
inline ets::MutRef<T> mutRefOf(T& ref) {
    return ets::MutRef<T>(ref);
}

template <typename T>
inline ets::MutRef<T> mutRefFrom(T& lvalue) {
    return ets::MutRef<T>(lvalue);
}

template <typename T>
inline T& mutRefValue(const ets::MutRef<T>& ref) {
    return ref.value();
}

// Versión const para los casos donde el user solo quiere leer a través del
// alias. Se modela con un overload que difiere solo en el tipo de retorno.
template <typename T>
inline const T& mutRefValueConst(const ets::MutRef<T>& ref) {
    return ref.value();
}
