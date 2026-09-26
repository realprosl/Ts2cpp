#pragma once

#include <string>
#include <vector>
#include "runtime/ast/ast_common.hpp"
#include "runtime/ast/ast_types.hpp"

namespace ets::ast {

struct Edge {
    NodeId node = invalidNode;
    std::string role;
};

struct Node {
    NodeKind kind = NodeKind::Unknown;
    Span span;
    std::string sourceKind;
    std::string name;
    std::string value;
    std::string operation;
    Type declaredType;
    Type inferredType;
    bool exported = false;
    bool mutableValue = false;
    bool asynchronous = false;
    bool output = false;
    bool mutableReference = false;
    bool variadic = false;
    std::vector<Edge> children;
};

struct Module {
    NodeId root = invalidNode;
    std::vector<Node> nodes;
};

inline const Node* child(const Module& module, const Node& node, std::string_view role) noexcept {
    for (const auto& edge : node.children) if (edge.role == role) return &module.nodes[edge.node];
    return nullptr;
}

inline std::vector<const Node*> children(const Module& module, const Node& node, std::string_view role = {}) {
    std::vector<const Node*> result;
    for (const auto& edge : node.children) if (role.empty() || edge.role == role) result.push_back(&module.nodes[edge.node]);
    return result;
}

} // namespace ets::ast
