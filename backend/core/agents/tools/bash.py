import asyncio
import subprocess
from typing import Optional


class BashTool:
    def __init__(self, workspace: str):
        self.workspace = workspace

    async def run(self, command: str, timeout: int = 60, cwd: Optional[str] = None) -> dict:
        try:
            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=cwd or self.workspace,
            )
            return {
                "success": result.returncode == 0,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "returncode": result.returncode,
            }
        except subprocess.TimeoutExpired:
            return {"success": False, "error": f"Command timed out after {timeout}s"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def run_stream(self, command: str, cwd: Optional[str] = None):
        try:
            process = subprocess.Popen(
                command,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=cwd or self.workspace,
            )
            
            while True:
                stdout = process.stdout.readline()
                if stdout:
                    yield {"type": "stdout", "content": stdout}
                
                stderr = process.stderr.readline()
                if stderr:
                    yield {"type": "stderr", "content": stderr}
                
                if process.poll() is not None:
                    break
                    
            remaining_stdout, remaining_stderr = process.communicate()
            if remaining_stdout:
                yield {"type": "stdout", "content": remaining_stdout}
            if remaining_stderr:
                yield {"type": "stderr", "content": remaining_stderr}
                
        except Exception as e:
            yield {"type": "error", "content": str(e)}
