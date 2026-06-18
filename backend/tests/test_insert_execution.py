import pytest
import fitz
from pathlib import Path
from core.insert.insertion_rule import InsertionRule, InsertMode, SourceType
from core.insert.insertion_plan import InsertionPlan
from core.insert.image_inserter import ImageInserter

def create_dummy_pdf(path: Path, pages: int = 1):
    doc = fitz.open()
    for i in range(pages):
        page = doc.new_page(width=100, height=100)
        page.insert_text((10, 10), f"Page {i+1}")
    doc.save(str(path))
    doc.close()

def create_dummy_image(path: Path):
    from PIL import Image
    img = Image.new("RGB", (50, 50), color="red")
    img.save(str(path), format="PNG")

@pytest.fixture
def temp_workspace(tmp_path):
    main_pdf = tmp_path / "main.pdf"
    create_dummy_pdf(main_pdf, pages=5) # 5 pages
    
    src_pdf = tmp_path / "src.pdf"
    create_dummy_pdf(src_pdf, pages=3) # 3 pages
    
    src_img = tmp_path / "img.png"
    create_dummy_image(src_img)
    
    # create output dir
    import config
    config.settings.OUTPUT_DIR = tmp_path / "output"
    config.settings.OUTPUT_DIR.mkdir()
    
    return tmp_path, main_pdf, src_pdf, src_img

def test_replace_offset_bug(temp_workspace):
    tmp_path, main_pdf, src_pdf, src_img = temp_workspace
    
    # Rule 1: Replace page 2 with a 3-page PDF
    # Rule 2: Insert Image AFTER page 2
    rule1 = InsertionRule(
        rule_id="R1", target_page=2, insert_mode=InsertMode.REPLACE,
        source_type=SourceType.PDF, source_file_id="src_pdf", source_pages="1-3", original_index=0
    )
    rule2 = InsertionRule(
        rule_id="R2", target_page=2, insert_mode=InsertMode.AFTER,
        source_type=SourceType.IMAGE, source_file_id="src_img", source_pages="", original_index=1
    )
    
    plan = InsertionPlan()
    resolved = plan.resolve([rule1, rule2])
    
    registry = {
        "src_pdf": src_pdf,
        "src_img": src_img
    }
    
    out_path = ImageInserter.execute(main_pdf, resolved, registry)
    
    # Original pages: 1, 2, 3, 4, 5
    # Replace page 2 with 3 pages -> 1, S1, S2, S3, 3, 4, 5 (total 7 pages)
    # Insert image AFTER page 2 -> it should go after S3!
    # So the order should be: 1, S1, S2, S3, IMG, 3, 4, 5 (total 8 pages)
    
    out_doc = fitz.open(str(out_path))
    assert out_doc.page_count == 8
    
    # verify page dimensions/content to ensure correct placement
    # original pages are 100x100
    # source pdf pages are 100x100
    # image page should be 100x100 (it matches target page size)
    # Actually, we can check the text or images.
    # Page index 4 (5th page) should be the image.
    page4 = out_doc[4]
    # Check if it has an image
    images = page4.get_images()
    assert len(images) > 0, "Image should be at index 4"
    
    out_doc.close()
