// cpp-httplib (https://github.com/yhirose/cpp-httplib, MIT License)
// Archivo de split-compile. Define la macro CPPHTTPLIB_COMPILE antes
// de incluir httplib.h para que las definiciones de los templates
// (Server, Client, Request, Response, etc.) emitan su implementación
// en este .cc en lugar de en cada .cpp que incluya el header.
//
// Compilacion: g++ -c -DCPPHTTPLIB_COMPILE runtime/external/httplib/httplib.cc
//                       -o build/httplib.o -I runtime/external/httplib
// Enlazado:    g++ programa.cpp build/httplib.o -lpthread -o programa
//
// Activar HTTPS (opcional):
//   #define CPPHTTPLIB_OPENSSL_SUPPORT
//   g++ ... -lssl -lcrypto

#include "httplib.h"
