# Third-party notices

## OpenAI Codex

The `apply_patch` grammar, parser behavior, fuzzy matching, mutation semantics, result formatting, diff rendering, standalone image-generation behavior, standalone web-search behavior, tool schemas, and compatibility scenarios in this package are adapted for Pi from the public OpenAI Codex implementation.

OpenAI Codex, Copyright 2025 OpenAI

OpenAI Codex is licensed under the Apache License, Version 2.0. A copy is included at [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt).

Source: <https://github.com/openai/codex>

## Pi AI

Selected OpenAI Codex transport, Responses stream processing, and history serialization methods are adapted from `@earendil-works/pi-ai`.

Pi AI, Copyright (c) 2025 Mario Zechner

Pi AI is licensed under the MIT License. A copy is included at [`LICENSES/pi-ai-MIT.txt`](LICENSES/pi-ai-MIT.txt).

Source: <https://github.com/earendil-works/pi/tree/main/packages/ai>

## Tree-sitter WASMs

`@2h2d/tree-sitter-wasms` supplies lifecycle-free grammar WASM assets used for
formatter-tolerant `apply_patch` matching.

Tree-sitter WASMs, Copyright (c) 2026 Kaan Ozdokmeci

Tree-sitter WASMs is licensed under the MIT License. A copy is included at
[`LICENSES/tree-sitter-wasms-MIT.txt`](LICENSES/tree-sitter-wasms-MIT.txt).
The dependency package includes the exact upstream license for each bundled
grammar under its own `LICENSES` directory.

Source: <https://github.com/2h2d-co/tree-sitter-wasms>

## Web Tree-sitter

`web-tree-sitter` supplies the official Tree-sitter WASM runtime used to load
and execute the packaged grammars.

Web Tree-sitter, Copyright (c) 2018 Max Brunsfeld

Web Tree-sitter is licensed under the MIT License. A copy is included at
[`LICENSES/web-tree-sitter-MIT.txt`](LICENSES/web-tree-sitter-MIT.txt).

Source: <https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web>
