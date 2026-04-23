"""
LspRunner — pilote un serveur LSP via JSON-RPC stdio.

Chaque instance spawn un subprocess (pyright, tsserver, rust-analyzer, gopls),
gère le framing LSP (`Content-Length: N\\r\\n\\r\\n{json}`), et expose deux
canaux async :
- `send(msg: dict)` : écrit sur stdin
- `receive() → dict | None` : lit le prochain message depuis stdout

Le bridge WebSocket (routes/lsp.py) fait juste du passe-plat entre le client
CodeMirror et ces canaux. Aucun parsing LSP côté Python — le serveur est une
boîte noire que le client initialise lui-même.
"""
from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Optional

import json

logger = logging.getLogger("gungnir.plugins.code.lsp")

# Langages supportés → commande + args. `None` si non installé dans l'image.
# Le runner retourne une erreur propre si la commande n'existe pas.
LSP_COMMANDS: dict[str, list[str]] = {
    "python": ["pyright-langserver", "--stdio"],
    "typescript": ["typescript-language-server", "--stdio"],
    "javascript": ["typescript-language-server", "--stdio"],
    "tsx": ["typescript-language-server", "--stdio"],
    "jsx": ["typescript-language-server", "--stdio"],
    "rust": ["rust-analyzer"],
    "go": ["gopls", "serve"],
}


def _dumps(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")


def _loads(data: bytes):
    return json.loads(data.decode("utf-8"))


class LspRunner:
    """Spawn + pipe un serveur LSP. Un runner = un subprocess."""

    def __init__(self, *, language: str, workspace: Path, user_id: int):
        self.language = language
        self.workspace = workspace
        self.user_id = user_id
        self.proc: Optional[asyncio.subprocess.Process] = None
        self.last_activity = time.time()
        self._read_lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()

    @property
    def is_running(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    async def start(self) -> None:
        """Spawn le subprocess LSP. Lève RuntimeError si la commande est
        absente du système (LSP non installé dans cette image)."""
        if self.is_running:
            return
        cmd = LSP_COMMANDS.get(self.language)
        if not cmd:
            raise RuntimeError(f"Langage LSP non supporté : {self.language}")

        self.workspace.mkdir(parents=True, exist_ok=True)
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=str(self.workspace),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as e:
            raise RuntimeError(
                f"LSP '{self.language}' introuvable : commande {cmd[0]} non "
                f"installée dans l'image (vérifier Dockerfile)."
            ) from e
        logger.info(
            f"LSP started uid={self.user_id} lang={self.language} "
            f"pid={self.proc.pid} cwd={self.workspace}"
        )

        # Drain stderr en tâche de fond — sinon le buffer sature et bloque.
        asyncio.create_task(self._drain_stderr())

    async def _drain_stderr(self) -> None:
        assert self.proc is not None and self.proc.stderr is not None
        while self.proc.returncode is None:
            line = await self.proc.stderr.readline()
            if not line:
                break
            # Les LSP (surtout rust-analyzer) sont verbeux — on garde en debug
            logger.debug(f"lsp[{self.language}] stderr: {line.decode(errors='replace').rstrip()}")

    async def send(self, msg: dict) -> bool:
        """Écrit un message JSON-RPC sur stdin avec framing LSP.
        Retourne False si le process est mort (permet au caller de stopper)."""
        if not self.is_running:
            return False
        body = _dumps(msg)
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
        async with self._write_lock:
            try:
                assert self.proc is not None and self.proc.stdin is not None
                self.proc.stdin.write(header + body)
                await self.proc.stdin.drain()
                self.last_activity = time.time()
                return True
            except (BrokenPipeError, ConnectionResetError):
                logger.warning(f"LSP {self.language} pipe broken — stopping")
                await self.stop()
                return False

    async def receive(self) -> Optional[dict]:
        """Lit le prochain message JSON-RPC depuis stdout. Retourne None si
        le process s'est terminé (EOF)."""
        if not self.is_running:
            return None
        async with self._read_lock:
            try:
                assert self.proc is not None and self.proc.stdout is not None
                # Parse headers LSP : lignes terminées \r\n, fin = ligne vide.
                content_length = 0
                while True:
                    line = await self.proc.stdout.readline()
                    if not line:
                        return None
                    line = line.rstrip(b"\r\n")
                    if not line:
                        break
                    if line.lower().startswith(b"content-length:"):
                        try:
                            content_length = int(line.split(b":", 1)[1].strip())
                        except ValueError:
                            content_length = 0
                if content_length <= 0 or content_length > 32 * 1024 * 1024:
                    # Protection : message trop gros ou header manquant
                    logger.warning(f"LSP {self.language} invalid content-length={content_length}")
                    return None
                body = await self.proc.stdout.readexactly(content_length)
                self.last_activity = time.time()
                return _loads(body)
            except (asyncio.IncompleteReadError, ConnectionResetError):
                return None
            except Exception as e:
                logger.warning(f"LSP {self.language} receive error: {e}")
                return None

    async def stop(self) -> None:
        """Arrête le subprocess proprement (kill si pas de réaction en 3s)."""
        if self.proc is None:
            return
        if self.proc.returncode is None:
            try:
                self.proc.terminate()
                try:
                    await asyncio.wait_for(self.proc.wait(), timeout=3.0)
                except asyncio.TimeoutError:
                    self.proc.kill()
                    await self.proc.wait()
            except ProcessLookupError:
                pass
        logger.info(f"LSP stopped uid={self.user_id} lang={self.language}")
        self.proc = None
