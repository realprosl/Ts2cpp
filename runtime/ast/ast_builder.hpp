#pragma once

#include <algorithm>
#include <cctype>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include "runtime/ast/ast_nodes.hpp"
#include "runtime/ets_syntax.hpp"

namespace ets::ast {

inline std::string textOf(const SyntaxNode& node, const std::string& source) {
    return source.substr(node.startByte, node.endByte - node.startByte);
}

inline std::string trimType(std::string value) {
    if (!value.empty() && value.front() == ':') value.erase(value.begin());
    const auto begin = value.find_first_not_of(" \t\r\n");
    if (begin == std::string::npos) return {};
    const auto end = value.find_last_not_of(" \t\r\n");
    return value.substr(begin, end - begin + 1);
}

inline const SyntaxNode* syntaxChild(const SyntaxNode& node, const SyntaxTree& tree, std::string_view role) {
    for (const auto& edge : node.children) if (edge.field == role) return &tree.nodes[edge.node];
    return nullptr;
}

inline NodeKind normalizedKind(std::string_view kind) noexcept {
    if (kind == "program") return NodeKind::Module;
    if (kind == "import_statement") return NodeKind::ImportDeclaration;
    if (kind == "export_statement") return NodeKind::ExportDeclaration;
    if (kind == "lexical_declaration" || kind == "variable_declarator") return NodeKind::VariableDeclaration;
    if (kind == "function_declaration") return NodeKind::FunctionDeclaration;
    if (kind == "interface_declaration") return NodeKind::InterfaceDeclaration;
    if (kind == "class_declaration") return NodeKind::ClassDeclaration;
    if (kind == "public_field_definition") return NodeKind::FieldDeclaration;
    if (kind == "method_definition") return NodeKind::MethodDeclaration;
    if (kind == "method_signature") return NodeKind::MethodSignature;
    if (kind == "required_parameter") return NodeKind::Parameter;
    if (kind == "rest_pattern") return NodeKind::RestParameter;
    if (kind == "type_parameter") return NodeKind::TypeParameter;
    if (kind == "constraint") return NodeKind::TypeConstraint;
    if (kind == "statement_block") return NodeKind::BlockStatement;
    if (kind == "class_body") return NodeKind::ClassBody;
    if (kind == "interface_body") return NodeKind::InterfaceBody;
    if (kind == "expression_statement") return NodeKind::ExpressionStatement;
    if (kind == "if_statement") return NodeKind::IfStatement;
    if (kind == "else_clause") return NodeKind::ElseClause;
    if (kind == "while_statement") return NodeKind::WhileStatement;
    if (kind == "for_statement") return NodeKind::ForStatement;
    if (kind == "break_statement") return NodeKind::BreakStatement;
    if (kind == "continue_statement") return NodeKind::ContinueStatement;
    if (kind == "return_statement") return NodeKind::ReturnStatement;
    if (kind == "identifier" || kind == "property_identifier") return NodeKind::IdentifierExpression;
    if (kind == "this") return NodeKind::ThisExpression;
    if (kind == "number") return NodeKind::NumberLiteral;
    if (kind == "string") return NodeKind::StringLiteral;
    if (kind == "true" || kind == "false") return NodeKind::BooleanLiteral;
    if (kind == "array") return NodeKind::ArrayLiteral;
    if (kind == "parenthesized_expression") return NodeKind::ParenthesizedExpression;
    if (kind == "arrow_function") return NodeKind::ArrowFunctionExpression;
    if (kind == "unary_expression") return NodeKind::UnaryExpression;
    if (kind == "await_expression") return NodeKind::AwaitExpression;
    if (kind == "binary_expression") return NodeKind::BinaryExpression;
    if (kind == "call_expression") return NodeKind::CallExpression;
    if (kind == "member_expression") return NodeKind::MemberExpression;
    if (kind == "subscript_expression") return NodeKind::IndexExpression;
    if (kind == "new_expression") return NodeKind::NewExpression;
    if (kind == "assignment_expression") return NodeKind::AssignmentExpression;
    if (kind == "type_annotation") return NodeKind::TypeAnnotation;
    if (kind == "predefined_type") return NodeKind::PrimitiveType;
    if (kind == "type_identifier") return NodeKind::NamedType;
    if (kind == "generic_type") return NodeKind::GenericType;
    if (kind == "array_type") return NodeKind::ArrayType;
    if (kind == "tuple_type") return NodeKind::TupleType;
    if (kind == "function_type") return NodeKind::FunctionType;
    if (kind == "formal_parameters") return NodeKind::ParameterList;
    if (kind == "arguments") return NodeKind::ArgumentList;
    if (kind == "type_parameters") return NodeKind::TypeParameterList;
    if (kind == "type_arguments") return NodeKind::TypeArgumentList;
    if (kind == "import_clause" || kind == "named_imports") return NodeKind::ImportClause;
    if (kind == "import_specifier") return NodeKind::ImportSpecifier;
    return NodeKind::Unknown;
}

class Builder {
    const std::string& source_;
    const SyntaxTree& syntax_;
    Module module_;

    std::string typeField(const SyntaxNode& syntax, std::string_view field) const {
        const auto* node = syntaxChild(syntax, syntax_, field);
        return node == nullptr ? "" : trimType(textOf(*node, source_));
    }

    std::string operatorBetween(const SyntaxNode& syntax) const {
        const auto* left = syntaxChild(syntax, syntax_, "left");
        const auto* right = syntaxChild(syntax, syntax_, "right");
        if (left != nullptr && right != nullptr && right->startByte >= left->endByte)
            return trimType(source_.substr(left->endByte, right->startByte - left->endByte));
        if (!syntax.children.empty()) {
            const auto& operand = syntax_.nodes[syntax.children.front().node];
            if (operand.startByte >= syntax.startByte) return trimType(source_.substr(syntax.startByte, operand.startByte - syntax.startByte));
        }
        return {};
    }

    NodeId append(const SyntaxNode& syntax, bool exported = false, std::string role = {}) {
        Node node;
        node.kind = normalizedKind(syntax.kind);
        node.sourceKind = syntax.kind;
        node.span = {syntax.startByte, syntax.endByte, syntax.startLine, syntax.startColumn};
        node.exported = exported;
        const std::string ownText = textOf(syntax, source_);
        node.mutableValue = node.kind == NodeKind::VariableDeclaration && ownText.rfind("let", 0) == 0;
        node.asynchronous = (node.kind == NodeKind::FunctionDeclaration || node.kind == NodeKind::MethodDeclaration) && ownText.rfind("async", 0) == 0;
        node.variadic = syntax.kind == "rest_pattern" || ownText.rfind("...", 0) == 0;
        const bool outPrefix = syntax.startByte >= 4 && source_.compare(syntax.startByte - 4, 4, "out ") == 0;
        const bool mutPrefix = syntax.startByte >= 4 && source_.compare(syntax.startByte - 4, 4, "mut ") == 0;
        node.output = syntax.kind == "required_parameter" && (ownText.rfind("out ", 0) == 0 || outPrefix);
        node.mutableReference = syntax.kind == "required_parameter" && (ownText.rfind("mut ", 0) == 0 || mutPrefix);
        if ((node.output || node.mutableReference) && node.span.start >= 4) {
            node.span.start -= 4;
            if (node.span.column > 4) node.span.column -= 4;
        }

        const SyntaxNode* variable = nullptr;
        if (syntax.kind == "lexical_declaration") {
            for (const auto& edge : syntax.children) if (syntax_.nodes[edge.node].kind == "variable_declarator") { variable = &syntax_.nodes[edge.node]; break; }
        }
        const SyntaxNode& attributes = variable == nullptr ? syntax : *variable;
        if (const auto* name = syntaxChild(attributes, syntax_, "name")) node.name = textOf(*name, source_);
        else if (const auto* pattern = syntaxChild(syntax, syntax_, "pattern")) node.name = textOf(*pattern, source_);
        else if (node.kind == NodeKind::IdentifierExpression || node.kind == NodeKind::NamedType || node.kind == NodeKind::PrimitiveType || node.kind == NodeKind::TypeParameter) node.name = ownText;
        if (node.kind == NodeKind::FunctionDeclaration || node.kind == NodeKind::MethodDeclaration || node.kind == NodeKind::MethodSignature)
            node.declaredType = parseType(typeField(syntax, "return_type"));
        else node.declaredType = parseType(typeField(attributes, "type"));
        if (node.kind == NodeKind::TypeAnnotation || node.kind == NodeKind::PrimitiveType || node.kind == NodeKind::NamedType ||
            node.kind == NodeKind::GenericType || node.kind == NodeKind::ArrayType || node.kind == NodeKind::TupleType || node.kind == NodeKind::FunctionType)
            node.declaredType = parseType(trimType(ownText));
        if (node.kind == NodeKind::NumberLiteral || node.kind == NodeKind::StringLiteral || node.kind == NodeKind::BooleanLiteral) node.value = ownText;
        if (node.kind == NodeKind::ImportDeclaration) {
            if (const auto* value = syntaxChild(syntax, syntax_, "source")) {
                node.value = textOf(*value, source_);
                if (node.value.size() >= 2) node.value = node.value.substr(1, node.value.size() - 2);
            }
        }
        if (node.kind == NodeKind::BinaryExpression || node.kind == NodeKind::AssignmentExpression || node.kind == NodeKind::UnaryExpression) node.operation = operatorBetween(syntax);
        if (node.kind == NodeKind::AwaitExpression) node.operation = "await";

        const NodeId id = static_cast<NodeId>(module_.nodes.size());
        module_.nodes.push_back(std::move(node));
        const auto& inputChildren = variable == nullptr ? syntax.children : variable->children;
        for (const auto& childEdge : inputChildren) {
            const auto& childSyntax = syntax_.nodes[childEdge.node];
            if (childSyntax.kind == "comment" || childSyntax.kind == "string_fragment" || childSyntax.kind == "escape_sequence") continue;
            const bool childExported = exported || syntax.kind == "export_statement";
            const NodeId childId = append(childSyntax, childExported, childEdge.field);
            module_.nodes[id].children.push_back({childId, childEdge.field});
        }
        (void)role;
        return id;
    }

public:
    Builder(const std::string& source, const SyntaxTree& syntax) : source_(source), syntax_(syntax) {}
    Module build() {
        module_.root = append(syntax_.nodes[syntax_.root]);
        return std::move(module_);
    }
};

struct SemanticIndex {
    std::unordered_map<std::string, std::string> symbols;
    std::unordered_map<std::string, std::string> functions;
    std::unordered_map<std::string, std::unordered_map<std::string, std::string>> fields;
    std::unordered_map<std::string, std::unordered_map<std::string, std::string>> methods;
};

inline std::string declaredName(const Module& module, const Node& node) {
    if (!node.name.empty()) return node.name;
    if (const auto* name = child(module, node, "name")) return name->name;
    if (const auto* pattern = child(module, node, "pattern")) return pattern->name;
    return {};
}

inline void indexDeclarations(const Module& module, NodeId id, SemanticIndex& index, std::string currentClass = {}) {
    const auto& node = module.nodes[id];
    const auto name = declaredName(module, node);
    if (node.kind == NodeKind::ClassDeclaration) currentClass = name;
    if (node.kind == NodeKind::VariableDeclaration || node.kind == NodeKind::Parameter || node.kind == NodeKind::RestParameter)
        if (!name.empty() && node.declaredType.name != "unknown") index.symbols[name] = node.declaredType.name;
    if (node.kind == NodeKind::FunctionDeclaration && !name.empty()) index.functions[name] = node.declaredType.name;
    if (node.kind == NodeKind::FieldDeclaration && !currentClass.empty() && !name.empty()) index.fields[currentClass][name] = node.declaredType.name;
    if (node.kind == NodeKind::MethodDeclaration && !currentClass.empty() && !name.empty()) index.methods[currentClass][name] = node.declaredType.name;
    for (const auto& edge : node.children) indexDeclarations(module, edge.node, index, currentClass);
}

inline std::string inferNode(Module& module, NodeId id, const SemanticIndex& index, std::string currentClass = {}) {
    auto& node = module.nodes[id];
    if (node.kind == NodeKind::ClassDeclaration) currentClass = declaredName(module, node);
    for (const auto& edge : node.children) inferNode(module, edge.node, index, currentClass);
    std::string type = node.declaredType.name;
    if (node.kind == NodeKind::NumberLiteral) type = "number";
    else if (node.kind == NodeKind::StringLiteral) type = "string";
    else if (node.kind == NodeKind::BooleanLiteral) type = "boolean";
    else if (node.kind == NodeKind::ParenthesizedExpression && !node.children.empty()) type = module.nodes[node.children.front().node].inferredType.name;
    else if (node.kind == NodeKind::ThisExpression) type = currentClass.empty() ? "unknown" : currentClass;
    else if (node.kind == NodeKind::IdentifierExpression) {
        const auto found = index.symbols.find(node.name);
        if (found != index.symbols.end()) type = found->second;
    } else if (node.kind == NodeKind::BinaryExpression) {
        const auto* left = child(module, node, "left"); const auto* right = child(module, node, "right");
        if (node.operation == "==" || node.operation == "!=" || node.operation == "<" || node.operation == "<=" || node.operation == ">" || node.operation == ">=" || node.operation == "&&" || node.operation == "||") type = "boolean";
        else if (node.operation == "+" && ((left && left->inferredType.name == "string") || (right && right->inferredType.name == "string"))) type = "string";
        else type = "number";
    } else if (node.kind == NodeKind::UnaryExpression) type = node.operation == "!" ? "boolean" : "number";
    else if (node.kind == NodeKind::AwaitExpression && !node.children.empty()) type = unwrapGeneric(module.nodes[node.children.front().node].inferredType.name, "Promise");
    else if (node.kind == NodeKind::AssignmentExpression) {
        const auto* value = child(module, node, "right"); if (value == nullptr) value = child(module, node, "value");
        type = value == nullptr ? "unknown" : value->inferredType.name;
    } else if (node.kind == NodeKind::NewExpression) {
        if (const auto* constructor = child(module, node, "constructor")) type = constructor->name;
    } else if (node.kind == NodeKind::MemberExpression) {
        const auto* object = child(module, node, "object"); const auto* property = child(module, node, "property");
        if (object && property) {
            const auto owner = index.fields.find(object->inferredType.name);
            if (owner != index.fields.end()) { const auto found = owner->second.find(property->name); if (found != owner->second.end()) type = found->second; }
            const auto methods = index.methods.find(object->inferredType.name);
            if (methods != index.methods.end()) { const auto found = methods->second.find(property->name); if (found != methods->second.end()) type = found->second; }
            if (object->inferredType.name.rfind("Result<", 0) == 0) {
                if (property->name == "isOk" || property->name == "isErr") type = "boolean";
                else if (property->name == "value") type = unwrapGeneric(object->inferredType.name, "Result");
                else if (property->name == "error") type = "string";
            }
        }
    } else if (node.kind == NodeKind::CallExpression) {
        const auto* function = child(module, node, "function");
        if (function) {
            if (function->kind == NodeKind::IdentifierExpression) { const auto found = index.functions.find(function->name); if (found != index.functions.end()) type = found->second; }
            else type = function->inferredType.name;
        }
    } else if (node.kind == NodeKind::IndexExpression) {
        const auto* object = child(module, node, "object"); if (object == nullptr) object = child(module, node, "value");
        if (object) {
            const auto parsed = parseType(object->inferredType.name);
            if (parsed.kind == TypeKind::Array && !parsed.arguments.empty()) type = parsed.arguments.front().name;
        }
    } else if (node.kind == NodeKind::ArrayLiteral) {
        std::string element = "unknown"; bool same = true;
        for (const auto& edge : node.children) { const auto& childNode = module.nodes[edge.node]; if (element == "unknown") element = childNode.inferredType.name; else if (element != childNode.inferredType.name) same = false; }
        type = same ? element + "[]" : "tuple";
    } else if (node.kind == NodeKind::ArrowFunctionExpression) {
        std::string result = node.declaredType.name;
        if (result == "unknown") {
            if (const auto* body = child(module, node, "body")) result = body->inferredType.name;
        }
        type = "function=>" + result;
    }
    node.inferredType = parseType(type);
    return node.inferredType.name;
}

inline bool buildTypedAst(const std::string& source, Module& output, std::string& error) noexcept {
    SyntaxTree syntax;
    if (!parseEstaticSyntax(source, syntax, error)) return false;
    output = Builder(source, syntax).build();
    SemanticIndex index;
    index.functions = {
        {"length", "number"}, {"numberToString", "string"}, {"charAt", "string"}, {"substring", "string"},
        {"indexOf", "number"}, {"startsWith", "boolean"}, {"trim", "string"}, {"lineCount", "number"},
        {"lineAt", "string"}, {"readFile", "boolean"}, {"writeFile", "boolean"}, {"appendFile", "boolean"},
        {"fileExists", "boolean"}, {"print", "void"}, {"write", "void"}, {"printError", "void"}, {"writeError", "void"},
        {"sleep", "Promise<void>"}, {"readFileAsync", "Promise<Result<string>>"}, {"writeFileAsync", "Promise<Result<boolean>>"},
        {"appendFileAsync", "Promise<Result<boolean>>"}, {"fileExistsAsync", "Promise<Result<boolean>>"}
    };
    index.functions.insert({
        {"copyFileAsync", "Promise<Result<boolean>>"}, {"moveFileAsync", "Promise<Result<boolean>>"}, {"removeFileAsync", "Promise<Result<boolean>>"},
        {"readFileUntil", "Promise<Result<string>>"}, {"writeFileUntil", "Promise<Result<boolean>>"}, {"appendFileUntil", "Promise<Result<boolean>>"},
        {"copyFileUntil", "Promise<Result<boolean>>"}, {"moveFileUntil", "Promise<Result<boolean>>"}, {"removeFileUntil", "Promise<Result<boolean>>"},
        {"listenTcp", "Result<TcpListener>"}, {"acceptTcp", "Promise<Result<TcpConnection>>"}, {"readTcp", "Promise<Result<string>>"},
        {"writeTcp", "Promise<Result<number>>"}, {"acceptTcpUntil", "Promise<Result<TcpConnection>>"}, {"readTcpUntil", "Promise<Result<string>>"},
        {"writeTcpUntil", "Promise<Result<number>>"}, {"createTlsServer", "Result<TlsContext>"}, {"acceptTls", "Promise<Result<TlsConnection>>"},
        {"readTls", "Promise<Result<string>>"}, {"writeTls", "Promise<Result<number>>"}, {"createCancellation", "CancellationSource"},
        {"cancellationToken", "CancellationToken"}, {"ioUringAvailable", "boolean"}
    });
    indexDeclarations(output, output.root, index);
    inferNode(output, output.root, index);
    return true;
}

} // namespace ets::ast
