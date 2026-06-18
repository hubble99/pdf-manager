import re
from enum import Enum
from pydantic import BaseModel

class InsertMode(str, Enum):
    BEFORE = "before"
    AFTER = "after"
    REPLACE = "replace"

class SourceType(str, Enum):
    IMAGE = "image"
    PDF = "pdf"

class InsertionRule(BaseModel):
    rule_id: str
    target_page: int
    insert_mode: InsertMode
    source_type: SourceType
    source_file_id: str
    source_pages: str
    original_index: int
    rotation: int = 0
    flip_h: bool = False
    source_total_pages: int = 1

    def parse_pages(self, page_range_str: str, total_pages: int) -> list[int]:
        if not page_range_str or not page_range_str.strip():
            return list(range(1, total_pages + 1))
            
        pages = []
        tokens = [t.strip() for t in page_range_str.split(",") if t.strip()]
        
        for token in tokens:
            if re.match(r"^\d+$", token):
                pages.append(int(token))
            elif re.match(r"^\d+-\d+$", token):
                start_str, end_str = token.split("-")
                start, end = int(start_str), int(end_str)
                if start <= end:
                    pages.extend(range(start, end + 1))
                else:
                    pages.extend(range(start, end - 1, -1))
            else:
                raise ValueError(f"Invalid page range format: '{token}'")
                
        # To maintain order but keep unique, though typically user wants exact order.
        # But if they typed "1,1", they might want page 1 twice.
        # Returning exact requested pages.
        return pages

    def validate_rule(self, max_page: int) -> None:
        if self.target_page < 1 or self.target_page > max_page:
            raise ValueError(f"target_page {self.target_page} is out of bounds (1-{max_page})")
            
        if self.source_type == SourceType.PDF:
            # Will raise ValueError if invalid
            self.parse_pages(self.source_pages, self.source_total_pages)
