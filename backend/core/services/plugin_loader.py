"""
Gungnir — Plugin Loader

Auto-discovers plugins from backend/plugins/, reads their manifest.json,
and mounts their FastAPI routes dynamically.
"""
import inspect
import json
import importlib
import logging
from pathlib import Path
from typing import Optional
from dataclasses import dataclass, field

from fastapi import FastAPI

logger = logging.getLogger("gungnir.plugins")


@dataclass
class PluginManifest:
    name: str
    display_name: str
    version: str = "1.0.0"
    icon: str = "Puzzle"
    route: str = ""
    sidebar_position: int = 99
    sidebar_section: str = "tools"
    backend_routes: bool = False
    backend_prefix: str = ""
    enabled_by_default: bool = True
    dependencies: list[str] = field(default_factory=list)
    lifecycle_hooks: bool = False


def discover_plugins(plugins_dir: Path) -> list[PluginManifest]:
    """Scan plugins/ directory for manifest.json files."""
    manifests = []

    if not plugins_dir.exists():
        logger.warning(f"Plugins directory not found: {plugins_dir}")
        return manifests

    for plugin_dir in sorted(plugins_dir.iterdir()):
        if not plugin_dir.is_dir():
            continue

        manifest_path = plugin_dir / "manifest.json"
        if not manifest_path.exists():
            logger.debug(f"Skipping {plugin_dir.name}: no manifest.json")
            continue

        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest = PluginManifest(**data)
            manifests.append(manifest)
            logger.info(f"Discovered plugin: {manifest.name} v{manifest.version}")
        except Exception as e:
            logger.error(f"Failed to load manifest for {plugin_dir.name}: {e}")

    return sorted(manifests, key=lambda m: m.sidebar_position)


def mount_plugin_routes(app: FastAPI, manifest: PluginManifest) -> bool:
    """
    Dynamically import and mount a plugin's routes.
    Returns True on success, False on failure (plugin is skipped).
    """
    if not manifest.backend_routes:
        return True

    module_name = f"backend.plugins.{manifest.name}.routes"
    try:
        module = importlib.import_module(module_name)
        router = getattr(module, "router", None)

        if router is None:
            logger.error(f"Plugin {manifest.name}: no 'router' found in {module_name}")
            return False

        prefix = manifest.backend_prefix or f"/api/plugins/{manifest.name}"
        app.include_router(router, prefix=prefix, tags=[manifest.display_name])
        logger.info(f"Mounted plugin routes: {manifest.name} -> {prefix}")
        return True

    except Exception as e:
        logger.error(f"Failed to mount plugin {manifest.name}: {e}")
        return False


async def call_plugin_lifecycle(manifest: PluginManifest, hook: str, **kwargs) -> Optional[any]:
    """Call a lifecycle hook on a plugin if it exists (on_startup, on_shutdown).

    Supports both sync and async hook functions — coroutines are awaited
    so that background tasks created inside the hook run under the app's
    event loop.
    """
    if not manifest.lifecycle_hooks:
        return None

    module_name = f"backend.plugins.{manifest.name}"
    try:
        module = importlib.import_module(module_name)
        hook_fn = getattr(module, hook, None)
        if hook_fn is None:
            return None
        result = hook_fn(**kwargs)
        if inspect.isawaitable(result):
            result = await result
        return result
    except Exception as e:
        logger.error(f"Plugin {manifest.name} lifecycle hook '{hook}' failed: {e}")
    return None
