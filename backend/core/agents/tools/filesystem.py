import os
import shutil
import hashlib
from pathlib import Path
from typing import Optional


class FileTool:
    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.workspace.mkdir(exist_ok=True, parents=True)

    def _safe_path(self, path: str) -> Path:
        p = (self.workspace / path).resolve()
        if not str(p).startswith(str(self.workspace.resolve())):
            raise ValueError("Path outside workspace")
        return p

    async def read(self, path: str) -> dict:
        try:
            p = self._safe_path(path)
            content = p.read_text(encoding="utf-8")
            return {"success": True, "content": content, "path": str(p)}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def write(self, path: str, content: str) -> dict:
        try:
            p = self._safe_path(path)
            p.parent.mkdir(exist_ok=True, parents=True)
            p.write_text(content, encoding="utf-8")
            return {"success": True, "path": str(p)}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def delete(self, path: str) -> dict:
        try:
            p = self._safe_path(path)
            if p.is_file():
                p.unlink()
            elif p.is_dir():
                shutil.rmtree(p)
            return {"success": True}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def list(self, path: str = ".") -> dict:
        try:
            p = self._safe_path(path)
            if not p.is_dir():
                return {"success": False, "error": "Not a directory"}
            
            items = []
            for item in p.iterdir():
                items.append({
                    "name": item.name,
                    "type": "dir" if item.is_dir() else "file",
                    "size": item.stat().st_size if item.is_file() else 0
                })
            return {"success": True, "items": items}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def exists(self, path: str) -> dict:
        try:
            p = self._safe_path(path)
            return {"success": True, "exists": p.exists()}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def stat(self, path: str) -> dict:
        try:
            p = self._safe_path(path)
            if not p.exists():
                return {"success": False, "error": "Not found"}
            
            stat = p.stat()
            return {
                "success": True,
                "size": stat.st_size,
                "created": stat.st_ctime,
                "modified": stat.st_mtime,
                "is_file": p.is_file(),
                "is_dir": p.is_dir(),
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def search(self, pattern: str, path: str = ".") -> dict:
        try:
            p = self._safe_path(path)
            results = []
            for item in p.rglob(pattern):
                if str(item).startswith(str(self.workspace.resolve())):
                    results.append(str(item.relative_to(self.workspace)))
            return {"success": True, "results": results}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def hash(self, path: str) -> dict:
        try:
            p = self._safe_path(path)
            if not p.is_file():
                return {"success": False, "error": "Not a file"}
            
            hasher = hashlib.sha256()
            hasher.update(p.read_bytes())
            return {"success": True, "hash": hasher.hexdigest()}
        except Exception as e:
            return {"success": False, "error": str(e)}
