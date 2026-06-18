from pydantic import BaseModel
from typing import List
from .insertion_rule import InsertionRule, InsertMode, SourceType

class ResolvedRule(BaseModel):
    rule: InsertionRule
    adjusted_page: int

class InsertionPlan:
    def _sort(self, rules: List[InsertionRule]) -> List[InsertionRule]:
        mode_order = {InsertMode.BEFORE: 0, InsertMode.REPLACE: 1, InsertMode.AFTER: 2}
        
        return sorted(
            rules,
            key=lambda r: (
                r.target_page,
                mode_order[r.insert_mode],
                r.original_index
            )
        )

    def resolve(self, rules: List[InsertionRule]) -> List[ResolvedRule]:
        sorted_rules = self._sort(rules)
        resolved = []
        
        for i, rule in enumerate(sorted_rules):
            adjusted_page = rule.target_page
            
            for prev in sorted_rules[:i]:
                affects = (
                    prev.target_page < rule.target_page or
                    (prev.target_page == rule.target_page and prev.insert_mode == InsertMode.BEFORE) or
                    (prev.target_page == rule.target_page and prev.insert_mode == InsertMode.REPLACE and rule.insert_mode == InsertMode.AFTER)
                )
                
                if affects:
                    if prev.insert_mode == InsertMode.REPLACE:
                        if prev.source_type == SourceType.IMAGE:
                            n = 1
                        else:
                            n = len(prev.parse_pages(prev.source_pages, prev.source_total_pages))
                        adjusted_page += n - 1
                    elif prev.source_type == SourceType.IMAGE:
                        adjusted_page += 1
                    elif prev.source_type == SourceType.PDF:
                        n = len(prev.parse_pages(prev.source_pages, prev.source_total_pages))
                        adjusted_page += n
                        
            resolved.append(ResolvedRule(rule=rule, adjusted_page=adjusted_page))
            
        return resolved
