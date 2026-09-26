#pragma once

#include <cstdint>
#include <string>

namespace ets::ast {

using NodeId = std::uint32_t;
inline constexpr NodeId invalidNode = UINT32_MAX;

struct Span {
    std::uint32_t start = 0;
    std::uint32_t end = 0;
    std::uint32_t line = 0;
    std::uint32_t column = 0;
};

enum class NodeKind {
    Module,
    ImportDeclaration, ExportDeclaration, VariableDeclaration,
    FunctionDeclaration, InterfaceDeclaration, ClassDeclaration,
    FieldDeclaration, MethodDeclaration, MethodSignature, ClassBody, InterfaceBody,
    Parameter, RestParameter, TypeParameter, TypeConstraint,
    BlockStatement, ExpressionStatement, IfStatement, ElseClause,
    WhileStatement, ForStatement, BreakStatement, ContinueStatement,
    ReturnStatement,
    IdentifierExpression, ThisExpression, NumberLiteral, StringLiteral,
    BooleanLiteral, ArrayLiteral, ParenthesizedExpression, ArrowFunctionExpression,
    UnaryExpression, AwaitExpression, BinaryExpression, CallExpression,
    MemberExpression, IndexExpression, NewExpression, AssignmentExpression,
    TypeAnnotation, PrimitiveType, NamedType, GenericType, ArrayType, TupleType, FunctionType,
    ParameterList, ArgumentList, TypeParameterList, TypeArgumentList,
    ImportClause, ImportSpecifier,
    Unknown
};

inline const char* nodeKindName(NodeKind kind) noexcept {
    switch (kind) {
        case NodeKind::Module: return "Module";
        case NodeKind::ImportDeclaration: return "ImportDeclaration";
        case NodeKind::ExportDeclaration: return "ExportDeclaration";
        case NodeKind::VariableDeclaration: return "VariableDeclaration";
        case NodeKind::FunctionDeclaration: return "FunctionDeclaration";
        case NodeKind::InterfaceDeclaration: return "InterfaceDeclaration";
        case NodeKind::ClassDeclaration: return "ClassDeclaration";
        case NodeKind::FieldDeclaration: return "FieldDeclaration";
        case NodeKind::MethodDeclaration: return "MethodDeclaration";
        case NodeKind::MethodSignature: return "MethodSignature";
        case NodeKind::ClassBody: return "ClassBody";
        case NodeKind::InterfaceBody: return "InterfaceBody";
        case NodeKind::Parameter: return "Parameter";
        case NodeKind::RestParameter: return "RestParameter";
        case NodeKind::TypeParameter: return "TypeParameter";
        case NodeKind::TypeConstraint: return "TypeConstraint";
        case NodeKind::BlockStatement: return "BlockStatement";
        case NodeKind::ExpressionStatement: return "ExpressionStatement";
        case NodeKind::IfStatement: return "IfStatement";
        case NodeKind::ElseClause: return "ElseClause";
        case NodeKind::WhileStatement: return "WhileStatement";
        case NodeKind::ForStatement: return "ForStatement";
        case NodeKind::BreakStatement: return "BreakStatement";
        case NodeKind::ContinueStatement: return "ContinueStatement";
        case NodeKind::ReturnStatement: return "ReturnStatement";
        case NodeKind::IdentifierExpression: return "IdentifierExpression";
        case NodeKind::ThisExpression: return "ThisExpression";
        case NodeKind::NumberLiteral: return "NumberLiteral";
        case NodeKind::StringLiteral: return "StringLiteral";
        case NodeKind::BooleanLiteral: return "BooleanLiteral";
        case NodeKind::ArrayLiteral: return "ArrayLiteral";
        case NodeKind::ParenthesizedExpression: return "ParenthesizedExpression";
        case NodeKind::ArrowFunctionExpression: return "ArrowFunctionExpression";
        case NodeKind::UnaryExpression: return "UnaryExpression";
        case NodeKind::AwaitExpression: return "AwaitExpression";
        case NodeKind::BinaryExpression: return "BinaryExpression";
        case NodeKind::CallExpression: return "CallExpression";
        case NodeKind::MemberExpression: return "MemberExpression";
        case NodeKind::IndexExpression: return "IndexExpression";
        case NodeKind::NewExpression: return "NewExpression";
        case NodeKind::AssignmentExpression: return "AssignmentExpression";
        case NodeKind::TypeAnnotation: return "TypeAnnotation";
        case NodeKind::PrimitiveType: return "PrimitiveType";
        case NodeKind::NamedType: return "NamedType";
        case NodeKind::GenericType: return "GenericType";
        case NodeKind::ArrayType: return "ArrayType";
        case NodeKind::TupleType: return "TupleType";
        case NodeKind::FunctionType: return "FunctionType";
        case NodeKind::ParameterList: return "ParameterList";
        case NodeKind::ArgumentList: return "ArgumentList";
        case NodeKind::TypeParameterList: return "TypeParameterList";
        case NodeKind::TypeArgumentList: return "TypeArgumentList";
        case NodeKind::ImportClause: return "ImportClause";
        case NodeKind::ImportSpecifier: return "ImportSpecifier";
        default: return "Unknown";
    }
}

inline bool isExpression(NodeKind kind) noexcept {
    return kind >= NodeKind::IdentifierExpression && kind <= NodeKind::AssignmentExpression;
}

} // namespace ets::ast
