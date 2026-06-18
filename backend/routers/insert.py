import json
import logging
from typing import List

import fitz
from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import ValidationError

from core.insert.image_inserter import ImageInserter
from core.insert.insertion_plan import InsertionPlan
from core.insert.insertion_rule import InsertionRule
from utils.file_utils import cleanup_temp_file, save_upload, sanitize_filename

logger = logging.getLogger("pdf_manager.routers.insert")
router = APIRouter(prefix="/insert", tags=["insert"])

@router.post("/")
async def insert_content(
    background_tasks: BackgroundTasks,
    main_pdf: UploadFile = File(...),
    rules_json: str = Form(...),
    source_files: List[UploadFile] = File(default=[]),
    output_filename: str = Form(default=""),
):
    try:
        rules_data = json.loads(rules_json)
        rules = [InsertionRule(**r) for r in rules_data]
    except (json.JSONDecodeError, ValidationError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid rules data: {str(e)}")
        
    main_pdf_path = await save_upload(main_pdf)
    background_tasks.add_task(cleanup_temp_file, main_pdf_path)
    
    file_registry = {}
    for i, file in enumerate(source_files):
        path = await save_upload(file)
        background_tasks.add_task(cleanup_temp_file, path)
        file_registry[str(i)] = path
        
    try:
        with fitz.open(str(main_pdf_path)) as doc:
            max_page = doc.page_count
            
        for rule in rules:
            if rule.source_file_id not in file_registry:
                raise ValueError(f"Source file ID {rule.source_file_id} not found in uploads")
                
            if rule.source_type == "pdf":
                with fitz.open(str(file_registry[rule.source_file_id])) as src_doc:
                    rule.source_total_pages = src_doc.page_count
            
            rule.validate_rule(max_page)
                
        plan = InsertionPlan()
        resolved_rules = plan.resolve(rules)
        
        out_path = ImageInserter.execute(main_pdf_path, resolved_rules, file_registry)
        background_tasks.add_task(cleanup_temp_file, out_path)
        
        with fitz.open(str(out_path)) as doc:
            total_pages = doc.page_count
            
        headers = {
            "X-Rules-Applied": str(len(resolved_rules)),
            "X-Total-Pages": str(total_pages),
            "Access-Control-Expose-Headers": "X-Rules-Applied, X-Total-Pages, Content-Disposition"
        }
        
        safe_name = sanitize_filename(
            output_filename or f"inserted_{main_pdf.filename or 'output'}",
            "pdf"
        )
        headers["Content-Disposition"] = f'attachment; filename="{safe_name}"'
        headers["X-Output-File"] = safe_name
        
        return FileResponse(
            out_path,
            media_type="application/pdf",
            filename=safe_name,
            headers=headers
        )
    except Exception as e:
        logger.error(f"Insert content error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
