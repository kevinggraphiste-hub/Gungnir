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


# ── Global MCP Manager ────────────────────────────────────────────────────────

class MCPManager:
    """Manages all MCP server connections."""

    def __init__(self):
        self.clients: dict[str, MCPStdioClient] = {}

    async def start_all(self, configs: list[dict]):
        """Start all configured MCP servers."""
        for cfg in configs:
            if not cfg.get("enabled", True):
                continue
            name = cfg["name"]
            try:
                client = MCPStdioClient(
                    name=name,
                    command=cfg["command"],
                    args=cfg.get("args", []),
                    env=cfg.get("env", {}),
                )
                await client.start()
                self.clients[name] = client
            except Exception as e:
                logger.warning(f"Failed to start MCP server '{name}': {e}")

    async def stop_all(self):
        """Stop all running MCP servers."""
        for client in self.clients.values():
            await client.stop()
        self.clients.clear()

    def get_all_schemas(self) -> list[dict]:
        """Get wolf tool schemas from all connected MCP servers."""
        schemas = []
        for client in self.clients.values():
            schemas.extend(client.get_wolf_schemas())
        return schemas

    def get_all_executors(self) -> dict[str, Any]:
        """Get wolf executors for all MCP tools."""
        executors = {}
        for client in self.clients.values():
            for t in client.tools:
                tool_name = f"mcp_{client.name}_{t['name']}"
                executors[tool_name] = _make_mcp_executor(client, t["name"])
        return executors

    def get_server_status(self) -> list[dict]:
        """Get status of all MCP servers."""
        return [
            {
                "name": name,
                "running": client.process is not None and client.process.returncode is None,
                "tools": len(client.tools),
                "tool_names": [t["name"] for t in client.tools],
            }
            for name, client in self.clients.items()
        ]


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
