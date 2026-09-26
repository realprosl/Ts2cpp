#pragma once

#include <cerrno>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <vector>

inline bool runNativeProcess(std::vector<std::string> arguments, const std::string& description, std::string& error) noexcept {
    std::vector<char*> native;
    native.reserve(arguments.size() + 1);
    for (auto& argument : arguments) native.push_back(argument.data());
    native.push_back(nullptr);
    const pid_t child = ::fork();
    if (child < 0) { error = "No se puede iniciar " + description + ": " + std::string(std::strerror(errno)); return false; }
    if (child == 0) { ::execvp(arguments[0].c_str(), native.data()); _exit(127); }
    int status = 0;
    while (::waitpid(child, &status, 0) < 0) {
        if (errno == EINTR) continue;
        error = "No se puede esperar a " + description + ": " + std::string(std::strerror(errno)); return false;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        const int code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
        error = description + " terminó con código " + std::to_string(code);
        return false;
    }
    return true;
}

inline bool sourceUsesTreeSitter(const std::string& source) noexcept {
    std::ifstream input(source, std::ios::binary);
    if (!input) return false;
    const std::string contents((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
    constexpr const char* markers[] = {
        "runtime/ets_syntax.hpp", "runtime/ets_ast.hpp",
        "validateSyntax(", "syntaxTreeJson(", "syntaxTreeRecords(",
        "estaticAstRecords(", "estaticTypedAstJson(", "estaticTypedAstRecords("
    };
    for (const char* marker : markers) if (contents.find(marker) != std::string::npos) return true;
    return false;
}

inline bool compileCpp(const std::string& source, const std::string& binary, const std::string& includeRoot,
                       const std::string& compiler, const std::string& profile, std::string& error) noexcept {
    const bool treeSitter = sourceUsesTreeSitter(source);
    std::vector<std::string> arguments = {compiler, "-std=c++20", "-fno-exceptions", "-pthread"};
    if (profile == "debug") { arguments.push_back("-O0"); arguments.push_back("-g"); }
    else if (profile == "release-native") { arguments.push_back("-O3"); arguments.push_back("-DNDEBUG"); arguments.push_back("-march=native"); arguments.push_back("-flto"); arguments.push_back("-ffunction-sections"); arguments.push_back("-fdata-sections"); }
    else { arguments.push_back("-O2"); arguments.push_back("-DNDEBUG"); arguments.push_back("-ffunction-sections"); arguments.push_back("-fdata-sections"); }
    arguments.push_back("-I" + includeRoot);
    arguments.push_back(source);
    if (treeSitter) {
        const std::string nativeDirectory = includeRoot + "/build/.estatic/native";
        if (!runNativeProcess({"bash", includeRoot + "/scripts/build-tree-sitter.sh", nativeDirectory, compiler}, "la construcción de Tree-sitter", error)) return false;
        arguments.push_back(nativeDirectory + "/tree-sitter-runtime.o");
        arguments.push_back(nativeDirectory + "/tree-sitter-typescript-parser.o");
        arguments.push_back(nativeDirectory + "/tree-sitter-typescript-scanner.o");
    }
    if (profile != "debug") { arguments.push_back("-Wl,--gc-sections"); arguments.push_back("-Wl,--as-needed"); arguments.push_back("-s"); }
    arguments.push_back("-o");
    arguments.push_back(binary);
    return runNativeProcess(std::move(arguments), "El compilador C++", error);
}
