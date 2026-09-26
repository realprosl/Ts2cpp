#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>
#include "runtime/ets_syntax.hpp"
#include "runtime/ast/ast_builder.hpp"
#include "runtime/ast/ast_serializer.hpp"

namespace ets {

struct AstSpan {
    std::uint32_t start = 0;
    std::uint32_t end = 0;
    std::uint32_t line = 0;
    std::uint32_t column = 0;
};

struct AstImportDeclaration {
    std::string specifier;
    std::vector<std::string> names;
};

struct AstVariableDeclaration {
    std::string name;
    std::string declaredType;
    AstSpan initializer;
    bool mutableValue = false;
};

struct AstFunctionDeclaration {
    std::string name;
    std::string returnType;
    AstSpan parameters;
    AstSpan body;
    bool asynchronous = false;
};

struct AstNominalDeclaration {
    std::string name;
};

enum class AstDeclarationKind { Import, Variable, Function, Class, Interface, Other };

struct AstDeclaration {
    AstDeclarationKind kind = AstDeclarationKind::Other;
    AstSpan span;
    bool exported = false;
    AstImportDeclaration importDeclaration;
    AstVariableDeclaration variableDeclaration;
    AstFunctionDeclaration functionDeclaration;
    AstNominalDeclaration nominalDeclaration;
};

struct AstModule {
    AstSpan span;
    std::vector<AstDeclaration> declarations;
};

inline AstSpan astSpan(const SyntaxNode& node) {
    return {node.startByte, node.endByte, node.startLine, node.startColumn};
}

inline std::string astText(const SyntaxNode& node, const std::string& source) {
    return source.substr(node.startByte, node.endByte - node.startByte);
}

inline const SyntaxNode* astChild(const SyntaxNode& node, const SyntaxTree& tree, std::string_view field) {
    for (const auto& child : node.children) if (child.field == field) return &tree.nodes[child.node];
    return nullptr;
}

inline const SyntaxNode* astFirstKind(const SyntaxNode& node, const SyntaxTree& tree, std::string_view kind) {
    for (const auto& child : node.children) {
        const auto& candidate = tree.nodes[child.node];
        if (candidate.kind == kind) return &candidate;
    }
    return nullptr;
}

inline std::string astTypeText(const SyntaxNode* node, const std::string& source) {
    if (node == nullptr) return "";
    std::string result = astText(*node, source);
    if (!result.empty() && result[0] == ':') result.erase(0, 1);
    const auto first = result.find_first_not_of(" \t\r\n");
    return first == std::string::npos ? "" : result.substr(first);
}

inline std::string astUnquote(std::string value) {
    if (value.size() >= 2 && ((value.front() == '\"' && value.back() == '\"') || (value.front() == '\'' && value.back() == '\''))) {
        value.erase(value.begin()); value.pop_back();
    }
    return value;
}

inline void collectImportNames(const SyntaxNode& node, const SyntaxTree& tree, const std::string& source, std::vector<std::string>& names) {
    if (node.kind == "import_specifier") {
        if (const auto* name = astChild(node, tree, "name")) names.push_back(astText(*name, source));
        return;
    }
    for (const auto& child : node.children) collectImportNames(tree.nodes[child.node], tree, source, names);
}

inline bool mapEstaticAst(const std::string& source, AstModule& module, std::string& error) noexcept {
    SyntaxTree syntax;
    if (!parseEstaticSyntax(source, syntax, error)) return false;
    const auto& root = syntax.nodes[syntax.root];
    module = {};
    module.span = astSpan(root);
    for (const auto& rootChild : root.children) {
        const SyntaxNode* node = &syntax.nodes[rootChild.node];
        bool exported = false;
        AstSpan declarationSpan = astSpan(*node);
        if (node->kind == "export_statement") {
            exported = true;
            const auto* declaration = astChild(*node, syntax, "declaration");
            if (declaration == nullptr) continue;
            node = declaration;
        }
        AstDeclaration output;
        output.exported = exported;
        output.span = declarationSpan;
        if (node->kind == "import_statement") {
            output.kind = AstDeclarationKind::Import;
            if (const auto* specifier = astChild(*node, syntax, "source")) output.importDeclaration.specifier = astUnquote(astText(*specifier, source));
            collectImportNames(*node, syntax, source, output.importDeclaration.names);
        } else if (node->kind == "lexical_declaration") {
            const auto* declarator = astFirstKind(*node, syntax, "variable_declarator");
            if (declarator == nullptr) { error = "Declaración de variable sin declarador en " + std::to_string(node->startLine) + ":" + std::to_string(node->startColumn); return false; }
            output.kind = AstDeclarationKind::Variable;
            if (const auto* name = astChild(*declarator, syntax, "name")) output.variableDeclaration.name = astText(*name, source);
            output.variableDeclaration.declaredType = astTypeText(astChild(*declarator, syntax, "type"), source);
            if (const auto* value = astChild(*declarator, syntax, "value")) output.variableDeclaration.initializer = astSpan(*value);
            output.variableDeclaration.mutableValue = astText(*node, source).rfind("let", 0) == 0;
        } else if (node->kind == "function_declaration") {
            output.kind = AstDeclarationKind::Function;
            if (const auto* name = astChild(*node, syntax, "name")) output.functionDeclaration.name = astText(*name, source);
            output.functionDeclaration.returnType = astTypeText(astChild(*node, syntax, "return_type"), source);
            if (const auto* parameters = astChild(*node, syntax, "parameters")) output.functionDeclaration.parameters = astSpan(*parameters);
            if (const auto* body = astChild(*node, syntax, "body")) output.functionDeclaration.body = astSpan(*body);
            output.functionDeclaration.asynchronous = astText(*node, source).rfind("async", 0) == 0;
        } else if (node->kind == "class_declaration") {
            output.kind = AstDeclarationKind::Class;
            if (const auto* name = astChild(*node, syntax, "name")) output.nominalDeclaration.name = astText(*name, source);
        } else if (node->kind == "interface_declaration") {
            output.kind = AstDeclarationKind::Interface;
            if (const auto* name = astChild(*node, syntax, "name")) output.nominalDeclaration.name = astText(*name, source);
        }
        module.declarations.push_back(std::move(output));
    }
    return true;
}

inline const char* astKindName(AstDeclarationKind kind) {
    switch (kind) {
        case AstDeclarationKind::Import: return "import";
        case AstDeclarationKind::Variable: return "variable";
        case AstDeclarationKind::Function: return "function";
        case AstDeclarationKind::Class: return "class";
        case AstDeclarationKind::Interface: return "interface";
        default: return "other";
    }
}

inline std::string astJoinNames(const std::vector<std::string>& names) {
    std::string output;
    for (const auto& name : names) { if (!output.empty()) output += ','; output += name; }
    return output;
}

inline std::string serializeEstaticAst(const AstModule& module) {
    std::string output = "module|0|" + std::to_string(module.span.line) + "|" + std::to_string(module.span.start) + "|" + std::to_string(module.span.end) + "||||";
    for (const auto& declaration : module.declarations) {
        std::string name;
        std::string type;
        std::string extra;
        if (declaration.kind == AstDeclarationKind::Import) { name = declaration.importDeclaration.specifier; type = astJoinNames(declaration.importDeclaration.names); }
        else if (declaration.kind == AstDeclarationKind::Variable) { name = declaration.variableDeclaration.name; type = declaration.variableDeclaration.declaredType; extra = declaration.variableDeclaration.mutableValue ? "mutable" : "const"; }
        else if (declaration.kind == AstDeclarationKind::Function) { name = declaration.functionDeclaration.name; type = declaration.functionDeclaration.returnType; extra = declaration.functionDeclaration.asynchronous ? "async" : "sync"; }
        else if (declaration.kind == AstDeclarationKind::Class || declaration.kind == AstDeclarationKind::Interface) name = declaration.nominalDeclaration.name;
        output += "\n" + std::string(astKindName(declaration.kind)) + "|" + (declaration.exported ? "1" : "0") + "|" +
                  std::to_string(declaration.span.line) + "|" + std::to_string(declaration.span.start) + "|" + std::to_string(declaration.span.end) + "|" +
                  name + "|" + type + "|" + extra + "|";
    }
    return output;
}

} // namespace ets

inline bool estaticAstRecords(const std::string& source, std::string& output, std::string& error) noexcept {
    ets::AstModule module;
    if (!ets::mapEstaticAst(source, module, error)) return false;
    output = ets::serializeEstaticAst(module);
    return true;
}

inline bool estaticTypedAstJson(const std::string& source, std::string& output, std::string& error) noexcept {
    ets::ast::Module module;
    if (!ets::ast::buildTypedAst(source, module, error)) return false;
    output = ets::ast::serializeJson(module);
    return true;
}

inline bool estaticTypedAstRecords(const std::string& source, std::string& output, std::string& error) noexcept {
    ets::ast::Module module;
    if (!ets::ast::buildTypedAst(source, module, error)) return false;
    output = ets::ast::serializeRecords(module);
    return true;
}
