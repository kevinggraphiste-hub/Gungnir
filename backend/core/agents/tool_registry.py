from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class Tool(BaseModel):
    name: str
    description: str
    schema: dict
    handler: str
    category: str = "general"
    created_at: datetime = None


class MCPServer(BaseModel):
    name: str
    url: str
    tools: list[Tool] = []
    enabled: bool = True


class DiscoveredTool(BaseModel):
    name: str
    description: str
    input_schema: dict
    source: str


class ToolRegistry:
    def __init__(self):
        self.tools: dict[str, dict] = {}
        self.mcp_servers: dict[str, MCPServer] = {}
        self.custom_tools: dict[str, dict] = {}

    def register_tool(self, name: str, schema: dict, handler: callable, category: str = "general"):
        self.tools[name] = {
            "name": name,
            "description": schema.get("description", ""),
            "schema": schema,
            "handler": handler,
            "category": category,
        }

    def unregister_tool(self, name: str):
        self.tools.pop(name, None)

    def list_tools(self) -> list[dict]:
        return [
            {**tool, "handler": "<function>"}
            for tool in self.tools.values()
        ]

    def get_tool_schema(self, name: str) -> dict | None:
        return self.tools.get(name, {}).get("schema")

    async def call_tool(self, name: str, params: dict) -> any:
        tool = self.tools.get(name)
        if not tool:
            return {"error": f"Tool {name} not found"}
        
        try:
            handler = tool.get("handler")
            if callable(handler):
                return await handler(**params)
            return {"error": "No handler registered"}
        except Exception as e:
            return {"error": str(e)}

    def add_mcp_server(self, name: str, url: str, enabled: bool = True):
        self.mcp_servers[name] = MCPServer(name=name, url=url, enabled=enabled)

    async def discover_mcp_tools(self):
        import httpx
        
        for name, server in self.mcp_servers.items():
            if not server.enabled:
                continue
            try:
                async with httpx.AsyncClient() as client:
                    resp = await client.post(
                        f"{server.url}/tools",
                        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                        timeout=10.0
                    )
                    if resp.status_code == 200:
                        data = resp.json()
                        tools = data.get("result", {}).get("tools", [])
                        for t in tools:
                            self.register_tool(
                                name=t["name"],
                                schema=t,
                                handler=None,
                                category="mcp"
                            )
            except Exception as e:
                print(f"Failed to discover MCP tools from {name}: {e}")

    def create_tool_from_prompt(self, name: str, description: str, prompt: str):
        self.custom_tools[name] = {
            "name": name,
            "description": description,
            "prompt": prompt,
            "type": "prompt_based",
        }
        self.register_tool(
            name=name,
            schema={
                "name": name,
                "description": description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "input": {"type": "string", "description": "Input for the prompt"}
                    },
                    "required": ["input"]
                }
            },
            handler=None,
            category="custom"
        )


tool_registry = ToolRegistry()
