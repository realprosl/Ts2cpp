# Tree-sitter runtime provenance

- Upstream: https://github.com/tree-sitter/tree-sitter
- Revision: `5b951eff4f8b1431e933ed0fe45e48fcd4036a38`
- License: MIT; see `LICENSE`.

Only the embeddable C runtime (`include/` and `src/`) is vendored. It is
compiled directly; the project does not use CMake.
