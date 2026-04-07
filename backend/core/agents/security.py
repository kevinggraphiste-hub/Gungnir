import re
import ast
import hashlib
from typing import Optional
from pathlib import Path
from datetime import datetime
import json


class SecurityError(Exception):
    def __init__(self, message: str, severity: str = "high"):
        self.message = message
        self.severity = severity
        super().__init__(message)


class SecurityScanner:
    DANGEROUS_PATTERNS = {
        "shell_injection": {
            "patterns": [
                r"subprocess\.run\s*\(\s*.*[\"\'].*\$",
                r"os\.system\s*\(",
                r"os\.popen\s*\(",
                r"eval\s*\(",
                r"exec\s*\(",
                r"__import__\s*\(\s*[\"']os[\"']",
                r"__import__\s*\(\s*[\"']subprocess[\"']",
                r"importlib\.import_module",
                r"getattr\s*\(\s*__builtins__",
            ],
            "severity": "critical",
            "description": "Shell injection vulnerability"
        },
        "file_system": {
            "patterns": [
                r"\.\.\/", 
                r"Path\s*\(\s*[\"'][\\/]etc",
                r"Path\s*\(\s*[\"'][\\/]proc",
                r"open\s*\(\s*[\"'][\\/]",
                r"shutil\.rmtree",
                r"shutil\.move",
            ],
            "severity": "high",
            "description": "File system access outside workspace"
        },
        "network": {
            "patterns": [
                r"requests\.",
                r"urllib\.",
                r"socket\.",
                r"http\.client\.",
            ],
            "severity": "medium",
            "description": "Network access"
        },
        "import_dangerous": {
            "patterns": [
                r"import\s+os",
                r"import\s+sys",
                r"import\s+subprocess",
                r"import\s+socket",
                r"from\s+os\s+import",
                r"from\s+subprocess\s+import",
                r"importlib",
                r"__import__",
                r"from\s+ctypes\s+import",
                r"from\s+multiprocessing\s+import",
            ],
            "severity": "medium",
            "description": "Potentially dangerous import"
        },
        "secrets": {
            "patterns": [
                r"api[_-]?key",
                r"secret",
                r"password",
                r"token",
                r"private[_-]?key",
            ],
            "severity": "high",
            "description": "Potential secret exposure"
        },
        "code_execution": {
            "patterns": [
                r"exec\(",
                r"eval\(",
                r"compile\(",
                r"__builtins__",
                r"globals\s*\(\s*\)",
                r"locals\s*\(\s*\)",
                r"getattr\s*\(",
                r"setattr\s*\(",
                r"delattr\s*\(",
                r"type\s*\(\s*['\"]",
            ],
            "severity": "critical",
            "description": "Code execution capability"
        },
        "encoding_bypass": {
            "patterns": [
                r"\\x[0-9a-fA-F]{2}",
                r"\\u[0-9a-fA-F]{4}",
                r"base64\.b64decode",
                r"codecs\.decode",
                r"bytes\.fromhex",
                r"chr\s*\(\s*\d+\s*\)",
            ],
            "severity": "high",
            "description": "Potential encoding-based bypass"
        },
    }

    def __init__(self, workspace: Path = None):
        self.workspace = workspace or Path.cwd()
        self.violations: list[dict] = []
        self.whitelisted_patterns: set[str] = set()

    def add_whitelist(self, pattern: str):
        self.whitelisted_patterns.add(pattern)

    def scan_code(self, code: str, file_path: str = None) -> dict:
        self.violations = []
        
        for category, info in self.DANGEROUS_PATTERNS.items():
            for pattern in info["patterns"]:
                matches = re.finditer(pattern, code, re.IGNORECASE)
                for match in matches:
                    if str(match.group()) in self.whitelisted_patterns:
                        continue
                    
                    self.violations.append({
                        "category": category,
                        "severity": info["severity"],
                        "description": info["description"],
                        "pattern": pattern,
                        "match": match.group(),
                        "position": match.start(),
                        "file": file_path,
                    })
        
        try:
            tree = ast.parse(code)
            self._check_ast(tree)
        except SyntaxError:
            pass
        
        return {
            "safe": len([v for v in self.violations if v["severity"] == "critical"]) == 0,
            "violations": self.violations,
            "score": self._calculate_score(),
        }

    def _check_ast(self, tree: ast.AST):
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                if hasattr(node.func, 'id'):
                    if node.func.id in ['eval', 'exec', 'compile']:
                        self.violations.append({
                            "category": "code_execution",
                            "severity": "critical",
                            "description": f"Dangerous function: {node.func.id}",
                            "pattern": node.func.id,
                            "line": getattr(node, 'lineno', 0),
                        })
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name in ['os', 'sys', 'subprocess', 'socket']:
                        self.violations.append({
                            "category": "import_dangerous",
                            "severity": "medium",
                            "description": f"Dangerous import: {alias.name}",
                            "pattern": f"import {alias.name}",
                            "line": getattr(node, 'lineno', 0),
                        })

    def _calculate_score(self) -> float:
        if not self.violations:
            return 100.0
        
        weights = {"critical": 30, "high": 15, "medium": 5, "low": 1}
        deduction = sum(weights.get(v["severity"], 10) for v in self.violations)
        return max(0.0, 100.0 - deduction)

    def scan_skill(self, skill_prompt: str, code: str = None) -> dict:
        violations = []
        
        if code:
            code_scan = self.scan_code(code)
            violations.extend(code_scan["violations"])
        
        dangerous_prompts = [
            r"ignore\s+(all\s+)?(safety|security|rules)",
            r"bypass\s+(security|restrictions)",
            r"jailbreak",
            r"system\s*:\s*ignore",
        ]
        
        for pattern in dangerous_prompts:
            matches = re.finditer(pattern, skill_prompt, re.IGNORECASE)
            for match in matches:
                violations.append({
                    "category": "prompt_injection",
                    "severity": "critical",
                    "description": "Potential prompt injection detected",
                    "pattern": pattern,
                })
        
        weights = {"critical": 30, "high": 15, "medium": 5, "low": 1}
        score = max(0.0, 100.0 - sum(weights.get(v["severity"], 10) for v in violations))
        return {
            "safe": len([v for v in violations if v["severity"] == "critical"]) == 0,
            "violations": violations,
            "approved": len([v for v in violations if v["severity"] in ["critical", "high"]]) == 0,
            "score": score,
        }

    def check_workspace_access(self, path: str) -> bool:
        try:
            p = Path(path).resolve()
            workspace_resolved = self.workspace.resolve()
            return str(p).startswith(str(workspace_resolved))
        except Exception:
            return False


security_scanner = SecurityScanner()
