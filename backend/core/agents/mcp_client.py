"""
Gungnir — MCP Client (stdio transport)

Launches MCP servers as subprocesses, discovers their tools via JSON-RPC,
and exposes them as wolf tool schemas + executors for the LLM to call.

Protocol: JSON-RPC 2.0 over stdin/stdout (MCP stdio transport).
Security: Uses asyncio.create_subprocess_exec (not shell=True) to prevent injection.
"""
import asyncio
import json
import logging
import os
from typing import Any, Optional

logger = logging.getLogger("gungnir.mcp")


class MCPStdioClient:
    """Manages a single MCP server subprocess."""

    def __init__(self, name: str, command: str, args: list[str], env: dict[str, str] = None):
        self.name = name
        self.command = command
        self.args = args
        self.env = env or {}
        self.process: Optional[asyncio.subprocess.Process] = None
        self.tools: list[dict] = []
        self._request_id = 0
        self._lock = asyncio.Lock()

    async def start(self):
        """Launch the MCP server subprocess using exec (no shell)."""
        full_env = {**os.environ, **self.env}
        try:
            # Uses create_subprocess_exec — safe from shell injection
            self.process = await asyncio.create_subprocess_exec(
                self.command, *self.args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=full_env,
            )
            logger.info(f"MCP server '{self.name}' started (pid {self.process.pid})")

            # Initialize
            await self._send_request("initialize", {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "gungnir", "version": "1.0.0"},
            })

            # Send initialized notification
            await self._send_notification("notifications/initialized", {})

            # Discover tools
            result = await self._send_request("tools/list", {})
            self.tools = result.get("tools", [])
            logger.info(f"MCP '{self.name}': {len(self.tools)} tools discovered")

        except FileNotFoundError:
            logger.error(f"MCP '{self.name}': command '{self.command}' not found")
            raise
        except Exception as e:
            logger.error(f"MCP '{self.name}' start failed: {e}")
            raise

    async def stop(self):
        """Shutdown the MCP server subprocess."""
        if self.process and self.process.returncode is None:
            try:
                self.process.stdin.close()
                await asyncio.wait_for(self.process.wait(), timeout=5)
            except asyncio.TimeoutError:
                self.process.kill()
            logger.info(f"MCP server '{self.name}' stopped")

    def is_alive(self) -> bool:
        """Check rapide : le process tourne-t-il ? N'émet aucune requête."""
        return bool(self.process and self.process.returncode is None)

    async def ping(self, timeout: float = 5.0) -> bool:
        """Check approfondi : JSON-RPC tools/list round-trip. Détecte les
        process zombies (alive=True côté OS mais stdio bloqué)."""
        if not self.is_alive():
            return False
        try:
            await asyncio.wait_for(
                self._send_request("tools/list", {}),
                timeout=timeout,
            )
            return True
        except Exception as e:
            logger.debug(f"MCP '{self.name}' ping failed: {e}")
            return False

    async def restart(self) -> bool:
        """Redémarre le subprocess avec la même config (command/args/env).

        Utilisé par le healthcheck auto quand un process est mort. Retourne
        True si la reconnexion a réussi. Détruit proprement l'ancien avant
        de relancer pour éviter les PID zombies."""
        try:
            if self.process:
                try:
                    await self.stop()
                except Exception:
                    pass
        finally:
            self.process = None
            self.tools = []
            self._request_id = 0
        try:
            await self.start()
            return True
        except Exception as e:
            logger.warning(f"MCP '{self.name}' restart failed: {e}")
            return False

    async def call_tool(self, tool_name: str, arguments: dict) -> Any:
        """Call a tool on the MCP server."""
        result = await self._send_request("tools/call", {
            "name": tool_name,
            "arguments": arguments,
        })
        # MCP returns content array, extract text
        content = result.get("content", [])
        texts = [c.get("text", "") for c in content if c.get("type") == "text"]
        return {"ok": True, "result": "\n".join(texts) if texts else json.dumps(result)}

    async def _send_request(self, method: str, params: dict) -> dict:
        """Send a JSON-RPC request and wait for response."""
        async with self._lock:
            if not self.process or self.process.returncode is not None:
                raise RuntimeError(f"MCP '{self.name}' is not running")

            self._request_id += 1
            msg = json.dumps({
                "jsonrpc": "2.0",
                "id": self._request_id,
                "method": method,
                "params": params,
            }) + "\n"

            self.process.stdin.write(msg.encode())
            await self.process.stdin.drain()

            # Read response line
            try:
                line = await asyncio.wait_for(
                    self.process.stdout.readline(), timeout=30
                )
            except asyncio.TimeoutError:
                raise TimeoutError(f"MCP '{self.name}' timeout on {method}")

            if not line:
                stderr = await self.process.stderr.read()
                raise RuntimeError(f"MCP '{self.name}' closed: {stderr.decode()[:500]}")

            resp = json.loads(line.decode())
            if "error" in resp:
                raise RuntimeError(f"MCP '{self.name}' error: {resp['error']}")
            return resp.get("result", {})

    async def _send_notification(self, method: str, params: dict):
        """Send a JSON-RPC notification (no response expected)."""
        if not self.process or self.process.returncode is not None:
            return
        msg = json.dumps({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }) + "\n"
        self.process.stdin.write(msg.encode())
        await self.process.stdin.drain()

    def get_wolf_schemas(self) -> list[dict]:
        """Convert MCP tools to OpenAI-compatible wolf tool schemas."""
        schemas = []
        for t in self.tools:
            schemas.append({
                "type": "function",
                "function": {
                    "name": f"mcp_{self.name}_{t['name']}",
                    "description": f"[MCP:{self.name}] {t.get('description', '')}",
                    "parameters": t.get("inputSchema", {"type": "object", "properties": {}}),
                },
            })
        return schemas


# ── Per-user MCP Manager ─────────────────────────────────────────────────────

class MCPManager:
    """Manages MCP server subprocesses scoped by user_id.

    Runtime state is routed per user: two users can run the same server name
    concurrently without colliding, and a user's tools are never exposed to
    another user's LLM calls. Lazy-started: servers boot on the first call to
    ensure_user_started() for a given user.
    """

    def __init__(self):
        # user_id → server_name → client
        self.clients: dict[int, dict[str, MCPStdioClient]] = {}
        # user_ids whose DB-backed configs have been loaded+started this process
        self._ensured_users: set[int] = set()

    def _slot(self, user_id: int) -> dict[str, MCPStdioClient]:
        return self.clients.setdefault(int(user_id), {})

    async def start_client_for_user(
        self,
        user_id: int,
        name: str,
        command: str,
        args: list[str],
        env: dict[str, str],
    ) -> MCPStdioClient:
        """Start (or replace) a single MCP server for a user and return the client."""
        slot = self._slot(user_id)
        old = slot.pop(name, None)
        if old:
            try:
                await old.stop()
            except Exception as e:
                logger.warning(f"MCP stop (replace) failed for user={user_id} name={name}: {e}")
        client = MCPStdioClient(name=name, command=command, args=args, env=env)
        await client.start()
        slot[name] = client
        return client

    async def stop_client_for_user(self, user_id: int, name: str) -> bool:
        """Stop a single MCP server for a user. Returns True if something was stopped."""
        slot = self.clients.get(int(user_id))
        if not slot:
            return False
        client = slot.pop(name, None)
        if not client:
            return False
        try:
            await client.stop()
        except Exception as e:
            logger.warning(f"MCP stop failed for user={user_id} name={name}: {e}")
        return True

    def get_client_for_user(self, user_id: int, name: str) -> Optional[MCPStdioClient]:
        return self.clients.get(int(user_id), {}).get(name)

    async def ensure_user_started(self, user_id: int) -> None:
        """Lazy-load the user's DB-backed MCP config and start any enabled servers.

        Runs at most once per user per process. Does not touch webhook-integration
        servers (those are started explicitly via their own start endpoint).
        """
        uid = int(user_id)
        if uid in self._ensured_users or uid <= 0:
            return
        self._ensured_users.add(uid)  # mark first to avoid re-entry on failure
        try:
            from backend.core.db.engine import get_session
            from backend.core.db.models import MCPServerConfig as DBMCPServerConfig
            from backend.core.config.settings import decrypt_value
            from sqlalchemy import select

            async for session in get_session():
                result = await session.execute(
                    select(DBMCPServerConfig).where(
                        DBMCPServerConfig.user_id == uid,
                        DBMCPServerConfig.enabled == True,  # noqa: E712
                    )
                )
                rows = result.scalars().all()
                for row in rows:
                    env = {
                        k: (decrypt_value(v) if isinstance(v, str) else v)
                        for k, v in (row.env_json or {}).items()
                    }
                    try:
                        await self.start_client_for_user(
                            uid, row.name, row.command, list(row.args_json or []), env
                        )
                        logger.info(f"MCP lazy-started for user={uid} name={row.name}")
                    except Exception as e:
                        logger.warning(f"MCP lazy-start failed user={uid} name={row.name}: {e}")
                break
        except Exception as e:
            logger.warning(f"ensure_user_started failed user={uid}: {e}")

    async def stop_user_servers(self, user_id: int) -> None:
        """Stop every MCP server running for a user."""
        slot = self.clients.pop(int(user_id), None)
        if not slot:
            return
        for name, client in slot.items():
            try:
                await client.stop()
            except Exception as e:
                logger.warning(f"MCP stop failed user={user_id} name={name}: {e}")
        self._ensured_users.discard(int(user_id))

    async def stop_all(self) -> None:
        """Shutdown hook: stop every running MCP server across all users."""
        for uid in list(self.clients.keys()):
            await self.stop_user_servers(uid)

    def get_user_schemas(self, user_id: int) -> list[dict]:
        """Wolf tool schemas from the user's running MCP servers."""
        schemas = []
        for client in self.clients.get(int(user_id), {}).values():
            schemas.extend(client.get_wolf_schemas())
        return schemas

    def get_user_executors(self, user_id: int) -> dict[str, Any]:
        """Wolf executors for the user's running MCP tools."""
        executors = {}
        for client in self.clients.get(int(user_id), {}).values():
            for t in client.tools:
                tool_name = f"mcp_{client.name}_{t['name']}"
                executors[tool_name] = _make_mcp_executor(client, t["name"])
        return executors

    def get_user_server_status(self, user_id: int) -> list[dict]:
        """Runtime status of the user's MCP servers."""
        return [
            {
                "name": name,
                "running": client.process is not None and client.process.returncode is None,
                "tools": len(client.tools),
                "tool_names": [t["name"] for t in client.tools],
            }
            for name, client in self.clients.get(int(user_id), {}).items()
        ]

    async def health_check_all(self, ping_timeout: float = 5.0) -> list[dict]:
        """Scanne tous les clients en mémoire, détecte les process morts ou
        non-responsives, et les redémarre automatiquement.

        Retourne une liste de dicts {user_id, name, was_alive, pinged,
        restarted, ok_after_restart} pour chaque client évalué. Utilisé par
        la boucle healthcheck en arrière-plan (voir
        _mcp_health_check_loop dans main.py)."""
        report = []
        for user_id, slot in list(self.clients.items()):
            for name, client in list(slot.items()):
                alive = client.is_alive()
                # Process mort : restart direct, pas la peine de ping
                if not alive:
                    ok = await client.restart()
                    report.append({
                        "user_id": user_id, "name": name,
                        "was_alive": False, "pinged": False,
                        "restarted": True, "ok_after_restart": ok,
                    })
                    if not ok:
                        logger.warning(f"MCP healthcheck: failed to restart {name} for user {user_id}")
                    continue
                # Process vivant : on vérifie qu'il réponde encore (zombie stdio)
                responsive = await client.ping(timeout=ping_timeout)
                if responsive:
                    report.append({
                        "user_id": user_id, "name": name,
                        "was_alive": True, "pinged": True,
                        "restarted": False, "ok_after_restart": True,
                    })
                    continue
                # Vivant mais non-responsive → restart
                logger.warning(f"MCP healthcheck: {name} for user {user_id} unresponsive, restarting")
                ok = await client.restart()
                report.append({
                    "user_id": user_id, "name": name,
                    "was_alive": True, "pinged": False,
                    "restarted": True, "ok_after_restart": ok,
                })
        return report


def _make_mcp_executor(client: MCPStdioClient, tool_name: str):
    """Create an async executor function for an MCP tool."""
    async def executor(**kwargs) -> dict:
        try:
            return await client.call_tool(tool_name, kwargs)
        except Exception as e:
            return {"ok": False, "error": f"MCP {client.name}/{tool_name}: {str(e)}"}
    return executor


# Singleton
mcp_manager = MCPManager()
