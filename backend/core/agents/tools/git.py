from pathlib import Path
from typing import Optional


class GitTool:
    def __init__(self, repo_path: str):
        self.repo_path = Path(repo_path)

    async def status(self) -> dict:
        import subprocess
        try:
            result = subprocess.run(
                ["git", "status", "--porcelain"],
                capture_output=True,
                text=True,
                cwd=self.repo_path,
            )
            return {"success": True, "status": result.stdout}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def log(self, limit: int = 10) -> dict:
        import subprocess
        try:
            result = subprocess.run(
                ["git", "log", f"-{limit}", "--oneline"],
                capture_output=True,
                text=True,
                cwd=self.repo_path,
            )
            return {"success": True, "log": result.stdout}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def diff(self, file: Optional[str] = None) -> dict:
        import subprocess
        try:
            cmd = ["git", "diff"]
            if file:
                cmd.append(file)
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                cwd=self.repo_path,
            )
            return {"success": True, "diff": result.stdout}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def add(self, files: list[str]) -> dict:
        import subprocess
        try:
            result = subprocess.run(
                ["git", "add"] + files,
                capture_output=True,
                text=True,
                cwd=self.repo_path,
            )
            return {"success": result.returncode == 0, "output": result.stdout}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def commit(self, message: str) -> dict:
        import subprocess
        try:
            result = subprocess.run(
                ["git", "commit", "-m", message],
                capture_output=True,
                text=True,
                cwd=self.repo_path,
            )
            return {"success": result.returncode == 0, "output": result.stdout, "error": result.stderr}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def branch(self) -> dict:
        import subprocess
        try:
            result = subprocess.run(
                ["git", "branch", "-a"],
                capture_output=True,
                text=True,
                cwd=self.repo_path,
            )
            return {"success": True, "branches": result.stdout}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def checkout(self, branch: str, create: bool = False) -> dict:
        import subprocess
        try:
            cmd = ["git", "checkout"]
            if create:
                cmd.append("-b")
            cmd.append(branch)
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                cwd=self.repo_path,
            )
            return {"success": result.returncode == 0, "output": result.stdout, "error": result.stderr}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def pull(self) -> dict:
        import subprocess
        try:
            result = subprocess.run(
                ["git", "pull"],
                capture_output=True,
                text=True,
                cwd=self.repo_path,
            )
            return {"success": result.returncode == 0, "output": result.stdout, "error": result.stderr}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def push(self) -> dict:
        import subprocess
        try:
            result = subprocess.run(
                ["git", "push"],
                capture_output=True,
                text=True,
                cwd=self.repo_path,
            )
            return {"success": result.returncode == 0, "output": result.stdout, "error": result.stderr}
        except Exception as e:
            return {"success": False, "error": str(e)}
