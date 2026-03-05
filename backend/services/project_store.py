"""
ProjectStore — thin service wrapper for project persistence.

Centralizes path-building and load/save operations so that API routes and
other services don't need to construct filesystem paths themselves.

All projects live under a single root directory::

    PROJECTS_DIR/
    ├── {project_id_1}/
    │   ├── project.json
    │   └── .proxy/proxy.mp4
    └── {project_id_2}/
        ├── project.json
        └── .proxy/proxy.mp4

``ProjectFile.save()`` and ``ProjectFile.load()`` do the actual serialization;
this class handles the directory structure around them.
"""

from pathlib import Path

from backend.models.project import ProjectFile


class ProjectStore:
    """
    Service layer for loading and saving project files.

    Instantiated with the root directory that contains all project sub-directories.
    Inject this into services and API handlers instead of hard-coding paths.
    """

    def __init__(self, projects_root: Path) -> None:
        """
        Args:
            projects_root: The top-level directory that contains all per-project
                           sub-directories (e.g., ``~/censor_me_projects``).
        """
        self._root = projects_root

    def project_dir(self, project_id: str) -> Path:
        """Return the directory path for a given project ID."""
        return self._root / project_id

    def load(self, project_id: str) -> ProjectFile:
        """
        Load and deserialize a project from disk.

        Raises:
            FileNotFoundError: If the project directory or ``project.json`` does not exist.
            pydantic.ValidationError: If the JSON schema does not match the current model.
        """
        return ProjectFile.load(self.project_dir(project_id))

    def save(self, project: ProjectFile) -> None:
        """
        Serialize a project to disk, creating its directory if needed.

        Updates ``project.updated_at`` as a side effect.
        """
        project_dir = self.project_dir(project.project_id)
        project_dir.mkdir(parents=True, exist_ok=True)
        project.save(project_dir)

    def exists(self, project_id: str) -> bool:
        """Return True if a project with this ID has a saved ``project.json``."""
        return (self.project_dir(project_id) / "project.json").exists()
