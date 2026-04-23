"""
SpearCode LSP (Language Server Protocol) — Phase 1.6-1.8.

Module responsable de :
- spawner des serveurs LSP en subprocess (pyright, tsserver, rust-analyzer, gopls)
- les piloter via JSON-RPC stdio
- les exposer au frontend CodeMirror via WebSocket per-user
- les arrêter paresseusement après inactivité

Design volontairement proche du pattern `mcp_client` : pool (user, lang) →
runner, auto-spawn à la première connexion, idle cleanup via tâche de fond.
"""
from backend.plugins.code.lsp.runner import LspRunner, LSP_COMMANDS
from backend.plugins.code.lsp.pool import lsp_pool, LspPool

__all__ = ["LspRunner", "LSP_COMMANDS", "lsp_pool", "LspPool"]
