"""
PDF Manager Backend — Response Models
Consistent Pydantic models for all API responses.
"""
from pydantic import BaseModel
from typing import Any, Optional


class SuccessResponse(BaseModel):
    status: str = "success"
    data: Any = None
    message: Optional[str] = None


class ErrorResponse(BaseModel):
    status: str = "error"
    message: str
    detail: Optional[str] = None

