import pytest
from core.insert.insertion_rule import InsertionRule, InsertMode, SourceType
from core.insert.insertion_plan import InsertionPlan

def create_rule(
    rule_id="test",
    target_page=1,
    insert_mode=InsertMode.BEFORE,
    source_type=SourceType.IMAGE,
    source_file_id="img1",
    source_pages="",
    original_index=0
) -> InsertionRule:
    return InsertionRule(
        rule_id=rule_id,
        target_page=target_page,
        insert_mode=insert_mode,
        source_type=source_type,
        source_file_id=source_file_id,
        source_pages=source_pages,
        original_index=original_index
    )

def test_1_single_rule_no_offset():
    # 1 aturan: insert image after page 2
    # Expected: adjusted_page = 2
    plan = InsertionPlan()
    rule = create_rule(target_page=2, insert_mode=InsertMode.AFTER)
    resolved = plan.resolve([rule])
    assert len(resolved) == 1
    assert resolved[0].adjusted_page == 2

def test_2_two_rules_second_affected_by_first():
    # Rule A: insert image after page 2 → menambah 1 halaman
    # Rule B: insert image after page 5
    # Expected: Rule B adjusted_page = 6
    plan = InsertionPlan()
    rule_a = create_rule(rule_id="A", target_page=2, insert_mode=InsertMode.AFTER, original_index=0)
    rule_b = create_rule(rule_id="B", target_page=5, insert_mode=InsertMode.AFTER, original_index=1)
    
    resolved = plan.resolve([rule_a, rule_b])
    
    # Sort order should be A then B
    assert resolved[0].rule.rule_id == "A"
    assert resolved[0].adjusted_page == 2
    
    assert resolved[1].rule.rule_id == "B"
    assert resolved[1].adjusted_page == 6

def test_3_before_vs_after_ordering():
    # Rule A: insert PDF (2 pages) before page 3
    # Rule B: insert image after page 3
    # Expected: Rule B adjusted = 3 + 2 = 5
    plan = InsertionPlan()
    rule_a = create_rule(rule_id="A", target_page=3, insert_mode=InsertMode.BEFORE, source_type=SourceType.PDF, source_pages="1-2", original_index=0)
    rule_b = create_rule(rule_id="B", target_page=3, insert_mode=InsertMode.AFTER, original_index=1)
    
    resolved = plan.resolve([rule_a, rule_b])
    
    assert resolved[0].rule.rule_id == "A"
    assert resolved[0].adjusted_page == 3
    
    assert resolved[1].rule.rule_id == "B"
    assert resolved[1].adjusted_page == 5

def test_4_replace_mode():
    # Rule A: replace page 2 dengan PDF 3 halaman (net: +2)
    # Rule B: insert image after page 5
    # Expected: Rule B adjusted = 5 + 2 = 7
    plan = InsertionPlan()
    rule_a = create_rule(rule_id="A", target_page=2, insert_mode=InsertMode.REPLACE, source_type=SourceType.PDF, source_pages="1-3", original_index=0)
    rule_b = create_rule(rule_id="B", target_page=5, insert_mode=InsertMode.AFTER, original_index=1)
    
    resolved = plan.resolve([rule_a, rule_b])
    
    assert resolved[0].rule.rule_id == "A"
    assert resolved[0].adjusted_page == 2
    
    assert resolved[1].rule.rule_id == "B"
    assert resolved[1].adjusted_page == 7

def test_5_same_target_page_before_processed_first():
    # Rule A: insert image before page 3
    # Rule B: insert image after page 3
    # Expected: Rule A diproses dulu, Rule B adjusted = 4
    plan = InsertionPlan()
    rule_a = create_rule(rule_id="A", target_page=3, insert_mode=InsertMode.BEFORE, original_index=1)
    rule_b = create_rule(rule_id="B", target_page=3, insert_mode=InsertMode.AFTER, original_index=0)
    
    # Notice original index, but BEFORE comes first in sorting!
    resolved = plan.resolve([rule_b, rule_a])
    
    assert resolved[0].rule.rule_id == "A"
    assert resolved[0].adjusted_page == 3
    
    assert resolved[1].rule.rule_id == "B"
    assert resolved[1].adjusted_page == 4

def test_6_complex_multi_rule():
    # Mix of rules
    plan = InsertionPlan()
    r1 = create_rule("R1", target_page=1, insert_mode=InsertMode.BEFORE, source_type=SourceType.IMAGE, original_index=0) # net +1
    r2 = create_rule("R2", target_page=2, insert_mode=InsertMode.REPLACE, source_type=SourceType.PDF, source_pages="1", original_index=1) # net 0
    r3 = create_rule("R3", target_page=2, insert_mode=InsertMode.AFTER, source_type=SourceType.IMAGE, original_index=2) # net +1
    r4 = create_rule("R4", target_page=5, insert_mode=InsertMode.REPLACE, source_type=SourceType.IMAGE, original_index=3) # net 0
    
    # Sort order:
    # 1. R1 (page 1, before) -> adjusted 1
    # 2. R2 (page 2, replace) -> affected by R1 (+1). adjusted 2 + 1 = 3
    # 3. R3 (page 2, after) -> affected by R1 (+1), not affected by R2 (after doesn't get affected by replace on same page?). 
    # Wait, R3 is AFTER page 2. R2 is REPLACE page 2. Does R2 affect R3?
    # R2 target_page == R3 target_page. R2 insert_mode is REPLACE. 
    # affects = prev.target_page < rule.target_page. 2 < 2 is false. So R2 does NOT affect R3!
    # Wait, should it? If we replace page 2, the old page 2 is gone, new page 2 is there. If we insert AFTER page 2, it still goes after the new page 2 (which is now page 3).
    # But wait, `affects` logic: (prev.target_page < rule.target_page or (prev.target_page == rule.target_page and prev.insert_mode == InsertMode.BEFORE)).
    # So if prev=REPLACE on same page, `affects` is False! So R2 does NOT affect R3 offset.
    # Therefore R3 adjusted = 2 + 1 (from R1) = 3.
    # Let's verify R4: page 5.
    # R1 affects (+1). R2 affects (+0). R3 affects (+1). Total offset = +2.
    # R4 adjusted = 5 + 2 = 7.
    
    resolved = plan.resolve([r4, r3, r2, r1])
    
    assert resolved[0].rule.rule_id == "R1"
    assert resolved[0].adjusted_page == 1
    
    assert resolved[1].rule.rule_id == "R2"
    assert resolved[1].adjusted_page == 3
    
    assert resolved[2].rule.rule_id == "R3"
    assert resolved[2].adjusted_page == 3
    
    assert resolved[3].rule.rule_id == "R4"
    assert resolved[3].adjusted_page == 7
