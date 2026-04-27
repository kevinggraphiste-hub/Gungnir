"""
Gungnir — Single source of truth for the application version.

Format : semver MAJOR.MINOR.PATCH
- MAJOR : breaking change (DB migration incompatible, auth break, plugin API rewrite)
- MINOR : nouvelle feature, ajout plugin, migration backward-compat
- PATCH : fix, refacto sans impact utilisateur
"""
__version__ = "2.90.1"
