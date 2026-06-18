import uuid
from pathlib import Path
from typing import Dict, List

import fitz

from config import settings
from .insertion_rule import InsertMode, SourceType
from .insertion_plan import ResolvedRule

class ImageInserter:
    @staticmethod
    def execute(
        main_pdf_path: Path,
        resolved_rules: List[ResolvedRule],
        file_registry: Dict[str, Path]
    ) -> Path:
        doc = fitz.open(str(main_pdf_path))
        
        for resolved in resolved_rules:
            rule = resolved.rule
            target_pno = resolved.adjusted_page - 1  # PyMuPDF is 0-indexed
            source_path = str(file_registry[rule.source_file_id])
            
            if rule.source_type == SourceType.IMAGE:
                # Handle images via Pillow to support WEBP, EXIF, etc.
                from PIL import Image, ImageOps
                import io
                with Image.open(source_path) as pil_img:
                    pil_img = ImageOps.exif_transpose(pil_img)
                    if getattr(rule, 'flip_h', False):
                        pil_img = ImageOps.mirror(pil_img)
                    if rule.rotation:
                        pil_img = pil_img.rotate(360 - (rule.rotation % 360), expand=True)
                    
                    # Convert to RGB if needed to save as JPEG
                    if pil_img.mode in ("RGBA", "P"):
                        bg = Image.new("RGB", pil_img.size, (255, 255, 255))
                        if pil_img.mode == "RGBA":
                            bg.paste(pil_img, mask=pil_img.split()[3])
                        else:
                            bg.paste(pil_img.convert("RGBA"), mask=pil_img.convert("RGBA").split()[3])
                        pil_img = bg
                    elif pil_img.mode != "RGB":
                        pil_img = pil_img.convert("RGB")
                        
                    buf = io.BytesIO()
                    pil_img.save(buf, format="JPEG", quality=95)
                    img_stream = buf.getvalue()
                    img_w, img_h = pil_img.size
                    
                # Use reference page for target dimensions
                ref_pno = min(target_pno, doc.page_count - 1)
                if ref_pno < 0:
                    page_w, page_h = 595.0, 842.0
                else:
                    ref_rect = doc[ref_pno].rect
                    page_w, page_h = ref_rect.width, ref_rect.height
                
                scale = min(page_w / img_w, page_h / img_h) if img_w > 0 and img_h > 0 else 1.0
                img_w_final = img_w * scale
                img_h_final = img_h * scale
                x = (page_w - img_w_final) / 2.0
                y = (page_h - img_h_final) / 2.0
                rect = fitz.Rect(x, y, x + img_w_final, y + img_h_final)
                
                if rule.insert_mode == InsertMode.BEFORE:
                    page = doc.new_page(pno=target_pno, width=page_w, height=page_h)
                    if img_stream:
                        page.insert_image(rect, stream=img_stream)
                    else:
                        page.insert_image(rect, filename=source_path)
                elif rule.insert_mode == InsertMode.AFTER:
                    page = doc.new_page(pno=target_pno + 1, width=page_w, height=page_h)
                    if img_stream:
                        page.insert_image(rect, stream=img_stream)
                    else:
                        page.insert_image(rect, filename=source_path)
                elif rule.insert_mode == InsertMode.REPLACE:
                    page = doc.new_page(pno=target_pno, width=page_w, height=page_h)
                    if img_stream:
                        page.insert_image(rect, stream=img_stream)
                    else:
                        page.insert_image(rect, filename=source_path)
                    doc.delete_page(target_pno + 1)
                    
            elif rule.source_type == SourceType.PDF:
                src_doc = fitz.open(source_path)
                pages_to_insert = rule.parse_pages(rule.source_pages, rule.source_total_pages)
                pages_to_insert_0idx = [p - 1 for p in pages_to_insert]
                
                if rule.insert_mode == InsertMode.BEFORE:
                    for i, p in enumerate(pages_to_insert_0idx):
                        doc.insert_pdf(src_doc, from_page=p, to_page=p, start_at=target_pno + i)
                elif rule.insert_mode == InsertMode.AFTER:
                    for i, p in enumerate(pages_to_insert_0idx):
                        doc.insert_pdf(src_doc, from_page=p, to_page=p, start_at=target_pno + 1 + i)
                elif rule.insert_mode == InsertMode.REPLACE:
                    for i, p in enumerate(pages_to_insert_0idx):
                        doc.insert_pdf(src_doc, from_page=p, to_page=p, start_at=target_pno + i)
                    doc.delete_page(target_pno + len(pages_to_insert_0idx))
                
                src_doc.close()
                
        out_name = f"inserted_{uuid.uuid4().hex[:8]}.pdf"
        out_path = settings.OUTPUT_DIR / out_name
        doc.save(str(out_path), garbage=4, deflate=True)
        doc.close()
        
        return out_path
