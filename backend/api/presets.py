"""Presets management API — role-based scan configuration presets."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.services.preset_service import (
    delete_custom_preset,
    get_preset,
    list_presets,
    save_custom_preset,
)

router = APIRouter()


class PresetCreate(BaseModel):
    preset_id: str
    name: str
    description: str = ""
    category: str = "custom"
    scan_settings: dict


@router.get("/")
async def get_presets() -> list[dict]:
    """Return all available presets (built-in + custom)."""
    return list_presets()


@router.get("/{preset_id}")
async def get_preset_by_id(preset_id: str) -> dict:
    """Get a single preset by ID."""
    preset = get_preset(preset_id)
    if preset is None:
        raise HTTPException(status_code=404, detail="Preset not found")
    return preset


@router.post("/custom")
async def create_custom_preset(body: PresetCreate) -> dict:
    """Save a custom preset."""
    save_custom_preset(body.model_dump())
    return {"saved": body.preset_id}


@router.delete("/custom/{preset_id}")
async def remove_custom_preset(preset_id: str) -> dict:
    """Delete a custom preset."""
    if not delete_custom_preset(preset_id):
        raise HTTPException(status_code=404, detail="Preset not found")
    return {"deleted": preset_id}
