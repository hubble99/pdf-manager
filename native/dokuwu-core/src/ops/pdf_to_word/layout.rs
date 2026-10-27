//! Turns a [`PageModel`] into Word structure: paragraphs, tables, images and
//! column sections, in reading order.
//!
//! The rules here are geometric and deliberately simple, so a wrong guess is
//! easy to trace. What they recover:
//! - paragraphs: lines are joined while the line before was full (the next
//!   word would not have fit) and the spacing and size stay the same;
//! - alignment and indents from line edges;
//! - headings from font size relative to the page's body text;
//! - bullet items, and rows of separated text as tab stops;
//! - underline and strike-through drawn as lines;
//! - ruled tables from their border lines, including merged cells;
//! - newspaper-style columns, as Word column sections;
//! - images at their place in the text flow, or behind the text when text is
//!   printed over them.

use super::model::{dominant, PageModel, Rect, Style, TextLine};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Left,
    Center,
    Right,
    Justify,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Run {
    /// May contain `\t`, written as a Word tab.
    pub text: String,
    pub style: Style,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Para {
    pub runs: Vec<Run>,
    pub align: Align,
    /// Points from the column's left edge.
    pub ind_left: f32,
    /// First line offset from `ind_left`; negative is a hanging indent.
    pub ind_first: f32,
    /// Points from the column's right edge.
    pub ind_right: f32,
    /// A rule under the paragraph, with its distance from the text in points.
    pub border_bottom: Option<f32>,
    /// Left tab stops, points from the column's left edge.
    pub tabs: Vec<f32>,
    pub space_before: f32,
    /// Baseline-to-baseline distance for paragraphs of several lines.
    pub line_pitch: Option<f32>,
    pub size: f32,
    pub heading: Option<u8>,
    /// A line at the very foot of the page (a footer) is positioned on the page
    /// instead of flowing, so text above it that Word sets a little taller can
    /// never push it onto a page of its own.
    pub frame: Option<Frame>,
}

/// A paragraph's place on the page, in points from the page's top-left corner.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub x: f32,
    pub y: f32,
    pub width: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ImageItem {
    /// Index into [`PageModel::images`].
    pub image: usize,
    pub width: f32,
    pub height: f32,
    pub align: Align,
    pub ind_left: f32,
    pub space_before: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VMerge {
    None,
    Restart,
    Continue,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VAlign {
    Top,
    Center,
    Bottom,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Cell {
    pub span: usize,
    pub vmerge: VMerge,
    pub width: f32,
    pub valign: VAlign,
    pub items: Vec<Item>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub height: f32,
    pub cells: Vec<Cell>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Table {
    pub cols: Vec<f32>,
    pub rows: Vec<Row>,
    pub ind_left: f32,
    pub space_before: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    Para(Para),
    Image(ImageItem),
    Table(Table),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Column {
    pub x0: f32,
    pub x1: f32,
    pub items: Vec<Item>,
}

/// A stretch of the page with a fixed number of columns. Becomes one Word
/// section.
#[derive(Clone, Debug, PartialEq)]
pub struct Band {
    pub columns: Vec<Column>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Background {
    pub image: usize,
    pub rect: Rect,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Margins {
    pub left: f32,
    pub right: f32,
    pub top: f32,
    pub bottom: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PageLayout {
    pub width: f32,
    pub height: f32,
    pub margins: Margins,
    pub bands: Vec<Band>,
    pub backgrounds: Vec<Background>,
    pub tables: usize,
    pub images: usize,
    pub has_text: bool,
}

/// Where Word puts a line's box around its baseline, as fractions of the
/// font size, for single line spacing (Arial and Times are close to this).
const WORD_ASCENT: f32 = 0.905;
const WORD_DESCENT: f32 = 0.245;
const WORD_LINE: f32 = WORD_ASCENT + WORD_DESCENT;

const BULLETS: &[char] = &['•', '●', '○', '◦', '▪', '■', '□', '‣', '⁃', '∙', '·', '–', '-', '*', '➢', '►', '✓', '✔', '\u{f0b7}', '\u{f0a7}'];

// ── Entry point ──────────────────────────────────────────────────────────────

pub fn layout_page(model: &PageModel) -> PageLayout {
    let page = Rect::new(0.0, 0.0, model.width, model.height);
    let mut lines: Vec<TextLine> = model.lines.iter().filter(|l| !l.is_blank()).cloned().collect();
    let mut rules: Vec<Rect> = model.rules.clone();
    mark_text_decorations(&mut lines, &mut rules);

    let body_size = dominant(lines.iter().flat_map(|l| l.glyphs.iter()).filter(|g| !g.ch.is_whitespace()).map(|g| g.style.size))
        .unwrap_or(11.0);

    // Images with text printed over them go behind the text. On an OCR'd scan
    // the invisible text is the content, so the scan picture is left out.
    //
    // A picture of any size with text over it (a letterhead's wave behind the
    // signature block) must not push that text down the page, so it is anchored
    // behind the text too. So is a footer decoration, a picture in the bottom
    // tenth of the page of a page that has text: a row of small icons would
    // otherwise become a stack of paragraphs under the text.
    let mut backgrounds = Vec::new();
    let mut flow_images: Vec<usize> = Vec::new();
    for (i, img) in model.images.iter().enumerate() {
        let big = img.bbox.area() >= 0.45 * page.area();
        let covers_text = lines.iter().any(|l| img.bbox.contains_point(l.bbox.cx(), l.bbox.cy(), 0.0));
        let footer = !lines.is_empty() && img.bbox.y0 > 0.9 * model.height;
        if big && covers_text && model.has_invisible_text {
            continue;
        }
        if covers_text || footer {
            backgrounds.push(Background { image: i, rect: img.bbox });
        } else {
            flow_images.push(i);
        }
    }

    // Tables first: their lines and images are taken out of the flow.
    let grids = find_grids(&rules, &page);
    let mut used_line = vec![false; lines.len()];
    let mut used_image = vec![false; model.images.len()];
    let mut tables: Vec<(Rect, GridTable)> = Vec::new();
    for g in grids {
        let inside: Vec<usize> = (0..lines.len())
            .filter(|&i| !used_line[i] && g.bbox.contains_point(lines[i].bbox.cx(), lines[i].bbox.cy(), 0.5))
            .collect();
        let filled = g.count_filled_cells(inside.iter().map(|&i| &lines[i]));
        if filled < 2 {
            continue;
        }
        for &i in &inside {
            used_line[i] = true;
        }
        for &i in &flow_images {
            if g.bbox.contains_point(model.images[i].bbox.cx(), model.images[i].bbox.cy(), 0.5) {
                used_image[i] = true;
            }
        }
        tables.push((g.bbox, g));
    }

    // Everything that flows: rows of text, images, tables.
    let mut elems: Vec<Elem> = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        if !used_line[i] {
            elems.push(Elem::Line(i, l.bbox));
        }
    }
    for &i in &flow_images {
        if !used_image[i] {
            elems.push(Elem::Image(i, model.images[i].bbox));
        }
    }
    for (t, (bbox, _)) in tables.iter().enumerate() {
        elems.push(Elem::Table(t, *bbox));
    }

    let has_text = !lines.is_empty();
    let content = elems.iter().map(|e| e.bbox()).reduce(|a, b| a.union(&b));
    let margins = page_margins(content, model.width, model.height);
    let text_area = (margins.left, model.width - margins.right);

    let gutters = find_gutters(&lines, &elems, text_area);
    let bands = split_bands(&elems, &gutters, &lines, text_area);

    let separators: Vec<Rect> = rules
        .iter()
        .filter(|r| r.height() <= 3.0 && r.width() >= 40.0)
        .filter(|r| !tables.iter().any(|(b, _)| b.contains_point(r.cx(), r.cy(), 3.0)))
        .copied()
        .collect();
    let ctx = Ctx { model, separators, lines: &lines, body_size, tables: &tables };
    let mut out_bands = Vec::new();
    let mut cursor = margins.top;
    for band in bands {
        let band_top = cursor;
        let mut columns = Vec::new();
        let mut bottom = cursor;
        for (x0, x1, members) in band {
            let (items, b) = ctx.build_column(&members, x0, x1, band_top);
            bottom = bottom.max(b);
            columns.push(Column { x0, x1, items });
        }
        cursor = bottom;
        out_bands.push(Band { columns });
    }
    if out_bands.is_empty() {
        out_bands.push(Band { columns: vec![Column { x0: text_area.0, x1: text_area.1, items: Vec::new() }] });
    }

    PageLayout {
        width: model.width,
        height: model.height,
        margins,
        bands: out_bands,
        backgrounds,
        tables: tables.len(),
        images: model.images.len(),
        has_text,
    }
}

#[derive(Clone, Copy, Debug)]
enum Elem {
    Line(usize, Rect),
    Image(usize, Rect),
    Table(usize, Rect),
}

impl Elem {
    fn bbox(&self) -> Rect {
        match *self {
            Elem::Line(_, r) | Elem::Image(_, r) | Elem::Table(_, r) => r,
        }
    }
}

fn page_margins(content: Option<Rect>, w: f32, h: f32) -> Margins {
    let Some(c) = content else {
        return Margins { left: 72.0, right: 72.0, top: 72.0, bottom: 72.0 };
    };
    let clamp = |v: f32, lo: f32, hi: f32| v.max(lo).min(hi);
    // Word fonts often run a little taller than the PDF's, so the bottom
    // margin is kept small to leave room before text spills onto a new page.
    let left = clamp(c.x0, 14.0, 144.0);
    // Ragged-right text stops short of the real margin; most documents have
    // equal side margins, and a slightly wider text area only makes Word wrap
    // later, never earlier.
    let right = clamp(w - c.x1, 14.0, 144.0).min(left);
    Margins {
        left,
        right,
        top: clamp(c.y0 - 2.0, 14.0, 144.0),
        // Never more than the space the content leaves, or its last line would not fit.
        bottom: clamp((h - c.y1) * 0.5, 0.0, 54.0),
    }
}

/// "1.", "a)", "iv.", "(2)": a list number standing apart from its item text.
fn is_list_marker(t: &str) -> bool {
    let inner = if let Some(rest) = t.strip_prefix('(') { rest.strip_suffix(')') } else { t.strip_suffix('.').or_else(|| t.strip_suffix(')')) };
    let Some(inner) = inner else { return false };
    let n = inner.chars().count();
    if n == 0 || n > 4 {
        return false;
    }
    (n <= 3 && inner.chars().all(|c| c.is_ascii_digit()))
        || (n == 1 && inner.chars().all(|c| c.is_ascii_alphabetic()))
        || inner.chars().all(|c| matches!(c, 'i' | 'v' | 'x' | 'I' | 'V' | 'X'))
}

// ── Underline and strike-through ─────────────────────────────────────────────

/// Thin horizontal lines just under or through text are text decoration, not
/// table borders. Marks the glyphs and removes the lines from `rules`.
fn mark_text_decorations(lines: &mut [TextLine], rules: &mut Vec<Rect>) {
    rules.retain(|r| {
        if r.height() > 2.0 || r.width() < 2.0 {
            return true;
        }
        let y = r.cy();
        for line in lines.iter_mut() {
            if line.bbox.overlap_x(r) < 1.0 {
                continue;
            }
            let size = line.main_size();
            let below = y - line.baseline;
            let underline = (-0.05 * size..=0.35 * size).contains(&below);
            let strike = (-0.5 * size..=-0.15 * size).contains(&below);
            if !underline && !strike {
                continue;
            }
            // A border under a whole table cell is wider than the text.
            if r.width() > line.bbox.width() + 0.5 * size {
                continue;
            }
            let mut hit = false;
            for g in line.glyphs.iter_mut() {
                let cx = (g.x0 + g.x1) / 2.0;
                if cx >= r.x0 - 0.5 && cx <= r.x1 + 0.5 {
                    if underline {
                        g.style.underline = true;
                    } else {
                        g.style.strike = true;
                    }
                    hit = true;
                }
            }
            if hit {
                return false;
            }
        }
        true
    });
}

// ── Ruled tables ─────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub(crate) struct GridTable {
    pub bbox: Rect,
    xs: Vec<f32>,
    ys: Vec<f32>,
    h: Vec<(f32, f32, f32)>,
    v: Vec<(f32, f32, f32)>,
}

const GRID_TOL: f32 = 2.5;

impl GridTable {
    fn has_v(&self, x: f32, y: f32) -> bool {
        self.v.iter().any(|&(vx, y0, y1)| (vx - x).abs() <= GRID_TOL && y >= y0 - GRID_TOL && y <= y1 + GRID_TOL)
    }

    fn has_h(&self, y: f32, x: f32) -> bool {
        self.h.iter().any(|&(hy, x0, x1)| (hy - y).abs() <= GRID_TOL && x >= x0 - GRID_TOL && x <= x1 + GRID_TOL)
    }

    fn rows(&self) -> usize {
        self.ys.len() - 1
    }

    fn cols(&self) -> usize {
        self.xs.len() - 1
    }

    /// Merged-cell structure: for every grid row, the cells as
    /// `(first column, span)`, and whether each continues the cell above.
    fn cells(&self) -> Vec<Vec<(usize, usize, bool)>> {
        let mut out: Vec<Vec<(usize, usize, bool)>> = Vec::new();
        for r in 0..self.rows() {
            let ymid = (self.ys[r] + self.ys[r + 1]) / 2.0;
            let mut row = Vec::new();
            let mut c = 0;
            while c < self.cols() {
                let start = c;
                while c + 1 < self.cols() && !self.has_v(self.xs[c + 1], ymid) {
                    c += 1;
                }
                let span = c - start + 1;
                let cont = r > 0
                    && out[r - 1].iter().any(|&(s, sp, _)| s == start && sp == span)
                    && (start..start + span).all(|k| !self.has_h(self.ys[r], (self.xs[k] + self.xs[k + 1]) / 2.0));
                row.push((start, span, cont));
                c += 1;
            }
            out.push(row);
        }
        out
    }

    /// The cell (row, first column) that owns point (x, y), after merges.
    fn owner(&self, cells: &[Vec<(usize, usize, bool)>], x: f32, y: f32) -> Option<(usize, usize)> {
        let r = (0..self.rows()).find(|&r| y >= self.ys[r] - 0.5 && y <= self.ys[r + 1] + 0.5)?;
        let c = (0..self.cols()).find(|&c| x >= self.xs[c] - 0.5 && x <= self.xs[c + 1] + 0.5)?;
        let &(start, span, _) = cells[r].iter().find(|&&(s, sp, _)| c >= s && c < s + sp)?;
        let mut rr = r;
        while rr > 0 && cells[rr].iter().any(|&(s, sp, cont)| s == start && sp == span && cont) {
            rr -= 1;
        }
        Some((rr, start))
    }

    fn count_filled_cells<'a>(&self, lines: impl Iterator<Item = &'a TextLine>) -> usize {
        let cells = self.cells();
        let mut filled: Vec<(usize, usize)> = Vec::new();
        for l in lines {
            if let Some(o) = self.owner(&cells, l.bbox.cx(), l.bbox.cy()) {
                if !filled.contains(&o) {
                    filled.push(o);
                }
            }
        }
        filled.len()
    }
}

/// Groups border lines into grids. Thin rectangles are lines; the edges of
/// small filled or stroked boxes count too, since tables are often drawn as
/// one box per cell.
pub(crate) fn find_grids(rules: &[Rect], page: &Rect) -> Vec<GridTable> {
    let mut h: Vec<(f32, f32, f32)> = Vec::new();
    let mut v: Vec<(f32, f32, f32)> = Vec::new();
    for r in rules {
        let (w, ht) = (r.width(), r.height());
        if ht <= 3.0 && w >= 6.0 {
            h.push((r.cy(), r.x0, r.x1));
        } else if w <= 3.0 && ht >= 6.0 {
            v.push((r.cx(), r.y0, r.y1));
        } else if w >= 6.0 && ht >= 6.0 && r.area() < 0.6 * page.area() {
            h.push((r.y0, r.x0, r.x1));
            h.push((r.y1, r.x0, r.x1));
            v.push((r.x0, r.y0, r.y1));
            v.push((r.x1, r.y0, r.y1));
        }
    }
    if h.len() < 2 || v.len() < 2 {
        return Vec::new();
    }

    // Connected components: a horizontal and a vertical line touch.
    let n = h.len() + v.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut [usize], i: usize) -> usize {
        let mut i = i;
        while p[i] != i {
            p[i] = p[p[i]];
            i = p[i];
        }
        i
    }
    for (hi, &(hy, hx0, hx1)) in h.iter().enumerate() {
        for (vi, &(vx, vy0, vy1)) in v.iter().enumerate() {
            let touch = vx >= hx0 - GRID_TOL && vx <= hx1 + GRID_TOL && hy >= vy0 - GRID_TOL && hy <= vy1 + GRID_TOL;
            if touch {
                let a = find(&mut parent, hi);
                let b = find(&mut parent, h.len() + vi);
                parent[a] = b;
            }
        }
    }
    let mut groups: Vec<(usize, Vec<usize>)> = Vec::new();
    for i in 0..n {
        let root = find(&mut parent, i);
        match groups.iter_mut().find(|(r, _)| *r == root) {
            Some((_, m)) => m.push(i),
            None => groups.push((root, vec![i])),
        }
    }

    let mut out = Vec::new();
    for (_, members) in groups {
        let gh: Vec<_> = members.iter().filter(|&&i| i < h.len()).map(|&i| h[i]).collect();
        let gv: Vec<_> = members.iter().filter(|&&i| i >= h.len()).map(|&i| v[i - h.len()]).collect();
        if gh.len() < 2 || gv.len() < 2 {
            continue;
        }
        let xs = cluster(gv.iter().map(|s| s.0).collect());
        let ys = cluster(gh.iter().map(|s| s.0).collect());
        if xs.len() < 2 || ys.len() < 2 || (xs.len() - 1) * (ys.len() - 1) < 2 {
            continue;
        }
        let bbox = Rect::new(xs[0], ys[0], *xs.last().unwrap(), *ys.last().unwrap());
        if bbox.width() < 20.0 || bbox.height() < 8.0 {
            continue;
        }
        out.push(GridTable { bbox, xs, ys, h: gh, v: gv });
    }
    out.sort_by(|a, b| a.bbox.y0.total_cmp(&b.bbox.y0));
    out
}

/// Sorted distinct values, merging those closer than the grid tolerance, and
/// dropping slivers thinner than a line of text would need.
fn cluster(mut vals: Vec<f32>) -> Vec<f32> {
    vals.sort_by(f32::total_cmp);
    let mut out: Vec<(f32, usize)> = Vec::new();
    for v in vals {
        match out.last_mut() {
            Some((m, n)) if v - *m / *n as f32 <= GRID_TOL => {
                *m += v;
                *n += 1;
            }
            _ => out.push((v, 1)),
        }
    }
    let mut res: Vec<f32> = out.into_iter().map(|(m, n)| m / n as f32).collect();
    // A double border (two lines 3-4pt apart) is one border.
    res.dedup_by(|b, a| (*b - *a) < 4.0);
    res
}

// ── Columns ──────────────────────────────────────────────────────────────────

/// Vertical white strips that separate text columns, as x ranges.
fn find_gutters(lines: &[TextLine], elems: &[Elem], area: (f32, f32)) -> Vec<(f32, f32)> {
    let (left, right) = area;
    let width = right - left;
    if width <= 0.0 {
        return Vec::new();
    }
    let free: Vec<&Rect> = elems.iter().filter_map(|e| if let Elem::Line(_, r) = e { Some(r) } else { None }).collect();
    let mut spans: Vec<(f32, f32)> = free.iter().filter(|r| r.width() < 0.55 * width).map(|r| (r.x0, r.x1)).collect();
    if spans.len() < 8 {
        return Vec::new();
    }
    spans.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut gaps = Vec::new();
    let mut reach = spans[0].1;
    for &(x0, x1) in &spans[1..] {
        if x0 - reach >= 8.0f32.max(0.015 * width) {
            gaps.push((reach, x0));
        }
        reach = reach.max(x1);
    }

    // Keep a gap only if it separates real columns: enough lines on each side,
    // and the lines on both sides do not come from the same MuPDF block (rows
    // of a borderless table do).
    let mut kept: Vec<(f32, f32)> = Vec::new();
    for &(g0, g1) in &gaps {
        let mut bounds: Vec<f32> = vec![left - 1.0];
        bounds.extend(kept.iter().map(|g| g.1));
        let lo = *bounds.last().unwrap();
        let next = gaps.iter().find(|g| g.0 > g1).map(|g| g.0).unwrap_or(right + 1.0);
        let left_lines: Vec<&TextLine> = lines.iter().filter(|l| l.bbox.x0 >= lo - 1.0 && l.bbox.x1 <= g0 + 1.0).collect();
        let right_lines: Vec<&TextLine> = lines.iter().filter(|l| l.bbox.x0 >= g1 - 1.0 && l.bbox.x1 <= next + 1.0).collect();
        if left_lines.len() < 4 || right_lines.len() < 4 {
            continue;
        }
        let col_w = |ls: &[&TextLine]| {
            let x0 = ls.iter().map(|l| l.bbox.x0).fold(f32::INFINITY, f32::min);
            let x1 = ls.iter().map(|l| l.bbox.x1).fold(f32::NEG_INFINITY, f32::max);
            x1 - x0
        };
        let (lw, rw) = (col_w(&left_lines), col_w(&right_lines));
        if lw < 0.2 * width || rw < 0.2 * width {
            continue;
        }
        // Columns hold running text: several lines fill most of the column.
        let full = |ls: &[&TextLine], w: f32| ls.iter().filter(|l| l.bbox.width() >= 0.7 * w).count();
        if full(&left_lines, lw) < 3 || full(&right_lines, rw) < 3 {
            continue;
        }
        let shared = left_lines.iter().filter(|l| right_lines.iter().any(|r| r.block == l.block)).count();
        if shared * 5 > left_lines.len() {
            continue;
        }
        kept.push((g0, g1));
    }
    kept
}

type BandSpec = Vec<(f32, f32, Vec<Elem>)>;

/// Cuts the page into bands: runs of column content, separated by elements
/// that span the gutters (titles, wide images, tables).
fn split_bands(elems: &[Elem], gutters: &[(f32, f32)], _lines: &[TextLine], area: (f32, f32)) -> Vec<BandSpec> {
    let mut sorted: Vec<Elem> = elems.to_vec();
    sorted.sort_by(|a, b| a.bbox().y0.total_cmp(&b.bbox().y0));
    if gutters.is_empty() {
        if sorted.is_empty() {
            return Vec::new();
        }
        return vec![vec![(area.0, area.1, sorted)]];
    }

    let mut col_bounds: Vec<(f32, f32)> = Vec::new();
    let mut x = area.0;
    for g in gutters {
        col_bounds.push((x, g.0));
        x = g.1;
    }
    col_bounds.push((x, area.1));
    let column_of = |r: &Rect| col_bounds.iter().position(|&(c0, c1)| r.x0 >= c0 - 2.0 && r.x1 <= c1 + 2.0);

    let mut bands: Vec<BandSpec> = Vec::new();
    let mut multi: Vec<Vec<Elem>> = vec![Vec::new(); col_bounds.len()];
    let mut single: Vec<Elem> = Vec::new();

    let flush_multi = |multi: &mut Vec<Vec<Elem>>, bands: &mut Vec<BandSpec>| {
        let used = multi.iter().filter(|c| !c.is_empty()).count();
        if used == 0 {
            return;
        }
        if used == 1 || multi.iter().map(|c| c.len()).sum::<usize>() < 4 {
            let mut all: Vec<Elem> = multi.iter_mut().flat_map(|c| c.drain(..)).collect();
            all.sort_by(|a, b| a.bbox().y0.total_cmp(&b.bbox().y0));
            bands.push(vec![(area.0, area.1, all)]);
        } else {
            let spec = multi
                .iter_mut()
                .zip(col_bounds.iter())
                .map(|(c, &(c0, c1))| (c0, c1, std::mem::take(c)))
                .collect();
            bands.push(spec);
        }
    };

    for e in sorted {
        match column_of(&e.bbox()) {
            Some(c) => {
                if !single.is_empty() {
                    bands.push(vec![(area.0, area.1, std::mem::take(&mut single))]);
                }
                multi[c].push(e);
            }
            None => {
                flush_multi(&mut multi, &mut bands);
                single.push(e);
            }
        }
    }
    flush_multi(&mut multi, &mut bands);
    if !single.is_empty() {
        bands.push(vec![(area.0, area.1, single)]);
    }

    // Neighbouring single-column bands are one section.
    let mut merged: Vec<BandSpec> = Vec::new();
    for b in bands {
        if b.len() == 1 {
            if let Some(last) = merged.last_mut() {
                if last.len() == 1 {
                    last[0].2.extend(b.into_iter().next().unwrap().2);
                    continue;
                }
            }
        }
        merged.push(b);
    }
    merged
}

// ── Paragraphs ───────────────────────────────────────────────────────────────

struct Ctx<'a> {
    model: &'a PageModel,
    /// Horizontal lines that are neither table borders nor text decoration.
    separators: Vec<Rect>,
    lines: &'a [TextLine],
    body_size: f32,
    tables: &'a [(Rect, GridTable)],
}

/// Lines on one baseline in one column: a visual row. Several segments mean
/// tab-separated text or a bullet and its item.
struct VisualRow<'a> {
    segs: Vec<&'a TextLine>,
}

impl<'b> VisualRow<'b> {
    fn first(&self) -> &'b TextLine {
        self.segs[0]
    }
}

struct OpenPara<'a> {
    rows: Vec<&'a TextLine>,
    left: f32,
    first_left: f32,
    size: f32,
    space_before: f32,
    /// Bullet item: text start of the item, bullet position.
    bullet: Option<(f32, f32)>,
    prefix: Vec<Run>,
}

impl<'a> Ctx<'a> {
    fn build_column(&self, members: &[Elem], x0: f32, x1: f32, top: f32) -> (Vec<Item>, f32) {
        let mut sorted = members.to_vec();
        sorted.sort_by(|a, b| a.bbox().y0.total_cmp(&b.bbox().y0));

        // Group text lines into visual rows, keeping images and tables in place.
        enum Piece<'b> {
            Row(VisualRow<'b>),
            Image(usize),
            Table(usize),
        }
        let mut pieces: Vec<Piece> = Vec::new();
        for e in sorted {
            match e {
                Elem::Line(i, _) => {
                    let line = &self.lines[i];
                    let size = line.main_size();
                    let joined = pieces.iter_mut().rev().take(4).find_map(|p| match p {
                        Piece::Row(row)
                            if (row.first().baseline - line.baseline).abs() <= 0.3 * size.min(row.first().main_size())
                                && row.segs.iter().all(|s| s.bbox.overlap_x(&line.bbox) < 1.0) =>
                        {
                            Some(row)
                        }
                        _ => None,
                    });
                    match joined {
                        Some(row) => {
                            row.segs.push(line);
                            row.segs.sort_by(|a, b| a.bbox.x0.total_cmp(&b.bbox.x0));
                        }
                        None => pieces.push(Piece::Row(VisualRow { segs: vec![line] })),
                    }
                }
                Elem::Image(i, _) => pieces.push(Piece::Image(i)),
                Elem::Table(i, _) => pieces.push(Piece::Table(i)),
            }
        }
        // Rows sharing a baseline can arrive after a taller neighbour, so
        // order rows by baseline, keeping other pieces at their top edge.
        let key = |p: &Piece| match p {
            Piece::Row(r) => r.first().baseline - 0.8 * r.first().main_size(),
            Piece::Image(i) => self.model.images[*i].bbox.y0,
            Piece::Table(i) => self.tables[*i].0.y0,
        };
        pieces.sort_by(|a, b| key(a).total_cmp(&key(b)));

        let mut items = Vec::new();
        let mut cursor = top;
        let mut open: Option<OpenPara> = None;
        let block_right = |block: u32| {
            self.lines.iter().filter(|l| l.block == block).map(|l| l.bbox.x1).fold(f32::NEG_INFINITY, f32::max)
        };

        for p in pieces {
            match p {
                Piece::Row(row) => {
                    // Vertical space is measured on Word's line boxes, which
                    // sit at fixed proportions around the baseline.
                    let size = row.segs.iter().map(|s| s.main_size()).fold(0.0f32, f32::max);
                    let top_y = row.first().baseline - WORD_ASCENT * size;
                    let bottom_y = row.first().baseline + WORD_DESCENT * size;
                    if row.segs.len() == 1 && !starts_with_bullet(row.first()) {
                        let line = row.first();
                        if let Some(op) = open.as_mut() {
                            if continues(op, line, x1.min(block_right(op.rows.last().unwrap().block)).max(op.rows.last().unwrap().bbox.x1)) {
                                if op.rows.len() == 1 && op.bullet.is_none() && line.bbox.x0 < op.left - 2.0 {
                                    op.left = line.bbox.x0;
                                }
                                op.rows.push(line);
                                cursor = cursor.max(bottom_y);
                                continue;
                            }
                        }
                        if let Some(op) = open.take() {
                            items.push(Item::Para(self.finish_para(op, x0, x1)));
                        }
                        open = Some(OpenPara {
                            rows: vec![line],
                            left: line.bbox.x0,
                            first_left: line.bbox.x0,
                            size: line.main_size(),
                            space_before: (top_y - cursor).max(0.0),
                            bullet: None,
                            prefix: Vec::new(),
                        });
                        cursor = cursor.max(bottom_y);
                        continue;
                    }
                    if let Some(op) = open.take() {
                        items.push(Item::Para(self.finish_para(op, x0, x1)));
                    }
                    let sb = (top_y - cursor).max(0.0);
                    cursor = cursor.max(bottom_y);
                    if let Some(op) = self.bullet_item(&row, sb) {
                        open = Some(op);
                    } else {
                        items.push(Item::Para(self.tabbed_para(&row, x0, x1, sb)));
                    }
                }
                Piece::Image(i) => {
                    if let Some(op) = open.take() {
                        items.push(Item::Para(self.finish_para(op, x0, x1)));
                    }
                    let b = self.model.images[i].bbox;
                    items.push(Item::Image(image_item(i, b, x0, x1, (b.y0 - cursor).max(0.0))));
                    cursor = cursor.max(b.y1);
                }
                Piece::Table(t) => {
                    if let Some(op) = open.take() {
                        items.push(Item::Para(self.finish_para(op, x0, x1)));
                    }
                    let (b, grid) = &self.tables[t];
                    items.push(Item::Table(self.build_table(grid, x0, (b.y0 - cursor).max(0.0))));
                    cursor = cursor.max(b.y1);
                }
            }
        }
        if let Some(op) = open.take() {
            items.push(Item::Para(self.finish_para(op, x0, x1)));
        }
        (items, cursor)
    }

    /// A row whose first segment is a bullet, or a line that starts with one.
    fn bullet_item<'b>(&self, row: &VisualRow<'b>, space_before: f32) -> Option<OpenPara<'b>>
    where
        'a: 'b,
    {
        let first = row.first();
        let text = first.text();
        let t = text.trim();
        // A bullet with more than one text segment after it is a row of a
        // list-like table; the tabbed paragraph keeps it intact.
        let is_bullet = t.chars().count() == 1 && BULLETS.contains(&t.chars().next().unwrap());
        if row.segs.len() == 2 && (is_bullet || is_list_marker(t)) && row.segs[1].bbox.x0 - first.bbox.x1 < 6.0 * first.main_size() {
            let item = row.segs[1];
            // The bullet keeps the item's look, as Word draws it in the item's font.
            let style = item.main_style().or(first.main_style())?;
            let prefix = vec![Run { text: format!("{t}\t"), style }];
            return Some(OpenPara {
                rows: vec![item],
                left: item.bbox.x0,
                first_left: first.bbox.x0,
                size: item.main_size(),
                space_before,
                bullet: Some((item.bbox.x0, first.bbox.x0)),
                prefix,
            });
        }
        if row.segs.len() == 1 && starts_with_bullet(first) {
            // "• text" in one line: the item text starts after the bullet and its space.
            let text_start = first
                .glyphs
                .iter()
                .skip(1)
                .find(|g| !g.ch.is_whitespace())
                .map(|g| g.x0)
                .unwrap_or(first.bbox.x0);
            return Some(OpenPara {
                rows: vec![first],
                left: text_start,
                first_left: first.bbox.x0,
                size: first.main_size(),
                space_before,
                bullet: Some((text_start, first.bbox.x0)),
                prefix: Vec::new(),
            });
        }
        None
    }

    fn tabbed_para(&self, row: &VisualRow, x0: f32, x1: f32, space_before: f32) -> Para {
        let mut runs = Vec::new();
        let mut tabs = Vec::new();
        for (k, seg) in row.segs.iter().enumerate() {
            if k > 0 {
                let style = seg.main_style().unwrap_or(runs.last().map(|r: &Run| r.style).unwrap_or_else(|| seg.glyphs[0].style));
                runs.push(Run { text: "\t".into(), style });
                tabs.push(seg.bbox.x0 - x0);
            }
            runs.extend(runs_of(seg));
        }
        let first = row.first();
        let size = dominant(row.segs.iter().map(|s| s.main_size())).unwrap_or(self.body_size);
        let _ = x1;
        Para {
            runs: merge_runs(runs),
            align: Align::Left,
            ind_left: first.bbox.x0 - x0,
            ind_first: 0.0,
            ind_right: 0.0,
            tabs,
            space_before,
            border_bottom: None,
            line_pitch: None,
            size,
            heading: None,
            frame: None,
        }
    }

    fn finish_para(&self, op: OpenPara, x0: f32, x1: f32) -> Para {
        let mut runs = op.prefix.clone();
        for (k, line) in op.rows.iter().enumerate() {
            if k > 0 {
                let prev = runs.last().map(|r| r.text.chars().last()).flatten();
                let next = line.glyphs.first().map(|g| g.ch);
                if needs_space(prev, next) {
                    let style = runs.last().map(|r| r.style).unwrap_or(line.glyphs[0].style);
                    runs.push(Run { text: " ".into(), style });
                }
            }
            let line_runs = runs_of(line);
            // A bullet typed in the line itself becomes bullet + tab.
            if k == 0 && op.bullet.is_some() && op.prefix.is_empty() {
                let mut chars = line.glyphs.iter();
                if let Some(b) = chars.next() {
                    let rest: Vec<_> = line.glyphs.iter().skip(1).skip_while(|g| g.ch.is_whitespace()).cloned().collect();
                    runs.push(Run { text: format!("{}\t", b.ch), style: b.style });
                    let tmp = TextLine { glyphs: rest, ..(*line).clone() };
                    runs.extend(runs_of(&tmp));
                    continue;
                }
            }
            runs.extend(line_runs);
        }
        let runs = merge_runs(runs);

        let pitch = if op.rows.len() >= 2 {
            let first = op.rows.first().unwrap().baseline;
            let last = op.rows.last().unwrap().baseline;
            Some((last - first) / (op.rows.len() - 1) as f32)
        } else {
            None
        };
        // Word adds extra line spacing above each line, the first included,
        // so the space before shrinks by that much to keep the first baseline.
        let mut space_before = op.space_before;
        if let Some(p) = pitch {
            let mult = line_multiple(p, op.size);
            space_before = (space_before - (mult - 1.0) * WORD_LINE * op.size).max(0.0);
        }

        let (align, ind_left, ind_first, tabs) = if let Some((text_x, bullet_x)) = op.bullet {
            (Align::Left, text_x - x0, bullet_x - text_x, vec![text_x - x0])
        } else {
            let align = detect_align(&op.rows, x0, x1);
            match align {
                Align::Left | Align::Justify => (align, op.left - x0, op.first_left - op.left, Vec::new()),
                _ => (align, 0.0, 0.0, Vec::new()),
            }
        };
        // A paragraph narrower than its column keeps its right edge.
        // Justified lines show the exact right edge; ragged lines only an
        // upper bound, so they keep a right indent only when clearly narrower.
        let ind_right = if op.rows.len() >= 2 {
            let right = op.rows[..op.rows.len() - 1].iter().map(|l| l.bbox.x1).fold(f32::NEG_INFINITY, f32::max);
            let gap = x1 - right;
            match align {
                Align::Justify if gap > 3.0 => gap - 0.5,
                Align::Left if gap > 0.1 * (x1 - x0) => gap - 0.5 * op.size,
                _ => 0.0,
            }
        } else {
            0.0
        };
        // A line drawn just under the paragraph (a title rule) becomes its bottom border.
        let last = op.rows.last().unwrap();
        let border_bottom = self.separators.iter().find_map(|r| {
            let below = r.cy() - (last.baseline + WORD_DESCENT * op.size);
            let overlaps = r.overlap_x(&last.bbox) > 0.5 * last.bbox.width().min(r.width());
            (overlaps && (-1.0..=1.5 * op.size).contains(&below)).then(|| below.clamp(0.0, 31.0))
        });

        let heading = if op.rows.len() <= 3 && self.body_size > 0.0 {
            let ratio = op.size / self.body_size;
            let all_bold = runs.iter().filter(|r| !r.text.trim().is_empty()).all(|r| r.style.bold);
            if ratio >= 1.6 {
                Some(1)
            } else if ratio >= 1.25 {
                Some(2)
            } else if ratio >= 1.1 && all_bold {
                Some(3)
            } else {
                None
            }
        } else {
            None
        };

        Para {
            runs,
            align,
            ind_left: if ind_left.abs() < 1.0 { 0.0 } else { ind_left },
            ind_first: if ind_first.abs() < 1.0 { 0.0 } else { ind_first },
            ind_right,
            tabs,
            space_before,
            border_bottom,
            line_pitch: pitch,
            size: op.size,
            heading,
            frame: self.footer_frame(&op.rows, op.size),
        }
    }

    /// The page position of a paragraph that lies in the bottom 6% of the page.
    fn footer_frame(&self, rows: &[&TextLine], size: f32) -> Option<Frame> {
        let first = rows.first()?;
        if first.baseline - WORD_ASCENT * size < 0.94 * self.model.height {
            return None;
        }
        let left = rows.iter().map(|l| l.bbox.x0).fold(f32::INFINITY, f32::min);
        let right = rows.iter().map(|l| l.bbox.x1).fold(f32::NEG_INFINITY, f32::max);
        // A little wider than the text so a font that runs wider does not wrap it.
        Some(Frame { x: left, y: first.baseline - WORD_ASCENT * size, width: (right - left) + 0.5 * size * 4.0 })
    }

    fn build_table(&self, grid: &GridTable, col_left: f32, space_before: f32) -> Table {
        let cells = grid.cells();
        let cols: Vec<f32> = grid.xs.windows(2).map(|w| w[1] - w[0]).collect();
        // Lines and images per owning cell.
        let mut content: Vec<((usize, usize), Vec<Elem>)> = Vec::new();
        for (i, l) in self.lines.iter().enumerate() {
            if !grid.bbox.contains_point(l.bbox.cx(), l.bbox.cy(), 0.5) {
                continue;
            }
            if let Some(o) = grid.owner(&cells, l.bbox.cx(), l.bbox.cy()) {
                push_content(&mut content, o, Elem::Line(i, l.bbox));
            }
        }
        for (i, img) in self.model.images.iter().enumerate() {
            if grid.bbox.contains_point(img.bbox.cx(), img.bbox.cy(), 0.5) {
                if let Some(o) = grid.owner(&cells, img.bbox.cx(), img.bbox.cy()) {
                    push_content(&mut content, o, Elem::Image(i, img.bbox));
                }
            }
        }

        let mut rows = Vec::new();
        for (r, row) in cells.iter().enumerate() {
            let mut out_cells = Vec::new();
            for &(start, span, cont) in row {
                let cx0 = grid.xs[start];
                let cx1 = grid.xs[start + span];
                let width = cx1 - cx0;
                let vmerge = if cont {
                    VMerge::Continue
                } else if r + 1 < cells.len() && cells[r + 1].iter().any(|&(s, sp, c)| s == start && sp == span && c) {
                    VMerge::Restart
                } else {
                    VMerge::None
                };
                let (items, valign) = if cont {
                    (Vec::new(), VAlign::Top)
                } else {
                    let members: Vec<Elem> = content.iter().find(|(o, _)| *o == (r, start)).map(|(_, m)| m.clone()).unwrap_or_default();
                    // Merged rows: the cell spans down to the last continued row.
                    let mut rend = r + 1;
                    while rend < cells.len() && cells[rend].iter().any(|&(s, sp, c)| s == start && sp == span && c) {
                        rend += 1;
                    }
                    let (cy0, cy1) = (grid.ys[r], grid.ys[rend]);
                    // Word adds its own cell padding (5.4pt each side).
                    let (mut items, _) = self.build_column(&members, cx0 + 5.4, cx1 - 5.4, cy0);
                    for it in items.iter_mut() {
                        if let Item::Para(p) = it {
                            p.frame = None;
                            p.space_before = 0.0;
                            if p.ind_left.abs() < 6.0 {
                                p.ind_left = 0.0;
                            }
                        }
                        if let Item::Image(im) = it {
                            im.space_before = 0.0;
                        }
                    }
                    let valign = match members.iter().map(|e| e.bbox()).reduce(|a, b| a.union(&b)) {
                        Some(b) => {
                            let top_gap = b.y0 - cy0;
                            let bottom_gap = cy1 - b.y1;
                            if (top_gap - bottom_gap).abs() <= 0.25 * (cy1 - cy0) {
                                VAlign::Center
                            } else if bottom_gap < top_gap {
                                VAlign::Bottom
                            } else {
                                VAlign::Top
                            }
                        }
                        None => VAlign::Top,
                    };
                    (items, valign)
                };
                out_cells.push(Cell { span, vmerge, width, valign, items });
            }
            rows.push(Row { height: grid.ys[r + 1] - grid.ys[r], cells: out_cells });
        }
        Table { cols, rows, ind_left: grid.xs[0] - col_left, space_before }
    }
}

fn push_content(content: &mut Vec<((usize, usize), Vec<Elem>)>, owner: (usize, usize), e: Elem) {
    match content.iter_mut().find(|(o, _)| *o == owner) {
        Some((_, m)) => m.push(e),
        None => content.push((owner, vec![e])),
    }
}

fn image_item(i: usize, b: Rect, x0: f32, x1: f32, space_before: f32) -> ImageItem {
    let colw = (x1 - x0).max(1.0);
    let scale = if b.width() > colw { colw / b.width() } else { 1.0 };
    let (w, h) = (b.width() * scale, b.height() * scale);
    let centered = (b.cx() - (x0 + x1) / 2.0).abs() <= 0.04 * colw && b.x0 - x0 > 5.0;
    ImageItem {
        image: i,
        width: w,
        height: h,
        align: if centered { Align::Center } else { Align::Left },
        ind_left: if centered { 0.0 } else { (b.x0 - x0).max(0.0).min((colw - w).max(0.0)) },
        space_before,
    }
}

/// Word's "multiple" line spacing that reproduces a baseline pitch, limited to
/// what the writer emits (0.83 to 3 lines).
pub fn line_multiple(pitch: f32, size: f32) -> f32 {
    (pitch / (size.max(1.0) * WORD_LINE)).clamp(200.0 / 240.0, 3.0)
}

fn starts_with_bullet(line: &TextLine) -> bool {
    let mut it = line.glyphs.iter();
    let Some(first) = it.next() else { return false };
    if !BULLETS.contains(&first.ch) {
        return false;
    }
    // "-" or "*" only count as bullets when followed by a space.
    match it.next() {
        Some(g) => g.ch.is_whitespace() || !matches!(first.ch, '-' | '*' | '–' | '·'),
        None => false,
    }
}

/// May `line` continue the open paragraph? `right` is where full lines end.
fn continues(op: &OpenPara, line: &TextLine, right: f32) -> bool {
    let last = *op.rows.last().unwrap();
    let size = line.main_size();
    if (size - op.size).abs() > 0.6 {
        return false;
    }
    let dy = line.baseline - last.baseline;
    if dy <= 0.0 || dy > 2.0 * size {
        return false;
    }
    if op.rows.len() >= 2 {
        let pitch = (last.baseline - op.rows[0].baseline) / (op.rows.len() - 1) as f32;
        if dy > pitch * 1.3 + 0.5 {
            return false;
        }
    }
    if line.block != last.block && dy > 1.45 * size {
        return false;
    }
    // Centred lines continue a centred paragraph.
    let centred_pair = (line.bbox.cx() - last.bbox.cx()).abs() <= 3.0 && (line.bbox.x0 - last.bbox.x0).abs() > 2.5;
    if centred_pair && op.bullet.is_none() {
        return true;
    }
    let aligned = (line.bbox.x0 - op.left).abs() <= 2.5;
    let first_line_indent = op.rows.len() == 1 && op.bullet.is_none() && line.bbox.x0 < last.bbox.x0 - 2.0 && last.bbox.x0 - line.bbox.x0 <= 8.0 * size;
    if !aligned && !first_line_indent {
        return false;
    }
    // The previous line ended because the next word did not fit.
    let next_word = first_word_width(line);
    right - last.bbox.x1 < next_word + 0.6 * size
}

fn first_word_width(line: &TextLine) -> f32 {
    let start = line.glyphs.first().map(|g| g.x0).unwrap_or(line.bbox.x0);
    let end = line
        .glyphs
        .iter()
        .skip(1)
        .find(|g| g.ch.is_whitespace())
        .map(|g| g.x0)
        .unwrap_or(line.bbox.x1);
    (end - start).max(0.0)
}

fn detect_align(rows: &[&TextLine], x0: f32, x1: f32) -> Align {
    let colw = (x1 - x0).max(1.0);
    let ccx = (x0 + x1) / 2.0;
    if rows.len() == 1 {
        let b = rows[0].bbox;
        if (b.cx() - ccx).abs() <= 3.0f32.max(0.03 * colw) && b.x0 - x0 > 0.08 * colw {
            return Align::Center;
        }
        if (b.x1 - x1).abs() <= 3.0 && b.x0 - x0 > 0.4 * colw {
            return Align::Right;
        }
        return Align::Left;
    }
    let body = &rows[..rows.len() - 1];
    let max_x1 = body.iter().map(|l| l.bbox.x1).fold(f32::NEG_INFINITY, f32::max);
    let lefts_aligned = rows.iter().skip(1).all(|l| (l.bbox.x0 - rows[1].bbox.x0).abs() <= 2.0);
    let rights_aligned = body.iter().all(|l| (l.bbox.x1 - max_x1).abs() <= 1.5);
    let all_centred = rows.iter().all(|l| (l.bbox.cx() - rows[0].bbox.cx()).abs() <= 3.0)
        && rows.iter().any(|l| (l.bbox.x0 - rows[0].bbox.x0).abs() > 2.5);
    if all_centred {
        return Align::Center;
    }
    if lefts_aligned && rights_aligned && (rows.len() > 2 || rows[rows.len() - 1].bbox.x1 < max_x1 - 3.0) {
        // Ragged text rarely ends two or more lines at the same point.
        return Align::Justify;
    }
    let all_rights = rows.iter().all(|l| (l.bbox.x1 - rows[0].bbox.x1).abs() <= 2.0);
    if all_rights && !lefts_aligned {
        return Align::Right;
    }
    Align::Left
}

fn needs_space(prev: Option<char>, next: Option<char>) -> bool {
    let (Some(p), Some(n)) = (prev, next) else { return false };
    if p.is_whitespace() || n.is_whitespace() {
        return false;
    }
    // A hyphen at the line end may be a real one ("well-known"); keep it and do not add a space.
    if p == '-' || p == '\u{00ad}' {
        return false;
    }
    !(is_cjk(p) || is_cjk(n))
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xac00..=0xd7af | 0xf900..=0xfaff | 0xff00..=0xffef)
}

fn runs_of(line: &TextLine) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();
    for g in &line.glyphs {
        match runs.last_mut() {
            Some(r) if r.style.same_run(&g.style) || (g.ch == ' ' && !g.style.underline) => r.text.push(g.ch),
            _ => runs.push(Run { text: g.ch.to_string(), style: g.style }),
        }
    }
    runs
}

fn merge_runs(runs: Vec<Run>) -> Vec<Run> {
    let mut out: Vec<Run> = Vec::new();
    for r in runs {
        match out.last_mut() {
            Some(l) if l.style.same_run(&r.style) => l.text.push_str(&r.text),
            _ => out.push(r),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::pdf_to_word::model::Glyph;

    fn style(size: f32) -> Style {
        Style { font: 0, size, bold: false, italic: false, underline: false, strike: false, color: 0 }
    }

    /// A line of monospace-ish glyphs, 0.5em wide each.
    fn line(text: &str, x0: f32, baseline: f32, size: f32, block: u32) -> TextLine {
        let w = size * 0.5;
        let glyphs: Vec<Glyph> = text
            .chars()
            .enumerate()
            .map(|(i, ch)| Glyph { ch, x0: x0 + i as f32 * w, x1: x0 + (i + 1) as f32 * w, style: style(size) })
            .collect();
        let x1 = x0 + text.chars().count() as f32 * w;
        TextLine { bbox: Rect::new(x0, baseline - size * 0.8, x1, baseline + size * 0.2), baseline, glyphs, block }
    }

    fn page(lines: Vec<TextLine>) -> PageModel {
        PageModel { width: 600.0, height: 800.0, fonts: vec!["Helvetica".into()], lines, ..Default::default() }
    }

    fn paras(layout: &PageLayout) -> Vec<&Para> {
        layout.bands.iter().flat_map(|b| b.columns.iter()).flat_map(|c| c.items.iter()).filter_map(|i| if let Item::Para(p) = i { Some(p) } else { None }).collect()
    }

    fn text(p: &Para) -> String {
        p.runs.iter().map(|r| r.text.as_str()).collect()
    }

    #[test]
    fn wrapped_lines_join_into_one_paragraph() {
        // 10pt text, 5pt per char; column ends near x=500 (block right edge).
        let l1 = line("aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn oooo pppp qqqq rrrr", 50.0, 100.0, 10.0, 0);
        let l2 = line("ssss tttt uuuu end.", 50.0, 112.0, 10.0, 0);
        let l3 = line("Next paragraph starts here and is short.", 50.0, 136.0, 10.0, 1);
        let layout = layout_page(&page(vec![l1, l2, l3]));
        let ps = paras(&layout);
        assert_eq!(ps.len(), 2, "{:?}", ps.iter().map(|p| text(p)).collect::<Vec<_>>());
        assert!(text(ps[0]).contains("rrrr ssss"));
        assert!(ps[1].space_before > 5.0);
    }

    #[test]
    fn short_line_ends_paragraph() {
        let l1 = line("Short line.", 50.0, 100.0, 10.0, 0);
        let l2 = line("aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn oooo pppp qqqq rrrr", 50.0, 112.0, 10.0, 0);
        let layout = layout_page(&page(vec![l1, l2]));
        assert_eq!(paras(&layout).len(), 2);
    }

    #[test]
    fn same_baseline_segments_become_tabs() {
        let a = line("Name", 100.0, 100.0, 10.0, 0);
        let b = line("Role", 250.0, 100.0, 10.0, 0);
        let c = line("City", 400.0, 100.0, 10.0, 0);
        let layout = layout_page(&page(vec![a, b, c]));
        let ps = paras(&layout);
        assert_eq!(ps.len(), 1);
        assert_eq!(text(ps[0]), "Name\tRole\tCity");
        assert_eq!(ps[0].tabs.len(), 2);
    }

    #[test]
    fn bullet_glyph_and_text_become_list_item() {
        let b = line("•", 60.0, 100.0, 10.0, 0);
        let t = line("First item", 78.0, 100.0, 10.0, 0);
        let layout = layout_page(&page(vec![b, t]));
        let ps = paras(&layout);
        assert_eq!(ps.len(), 1);
        assert_eq!(text(ps[0]), "•\tFirst item");
        assert!(ps[0].ind_first < 0.0);
    }

    #[test]
    fn list_markers() {
        for ok in ["1.", "12)", "a.", "(3)", "iv.", "B)"] {
            assert!(is_list_marker(ok), "{ok}");
        }
        for no in ["1.5", "abc.", "", "word", "2020."] {
            assert!(!is_list_marker(no), "{no}");
        }
    }

    #[test]
    fn numbered_item_gets_hanging_indent() {
        let n = line("1.", 50.0, 100.0, 10.0, 0);
        let t = line("Reduce manual work", 68.0, 100.0, 10.0, 0);
        let layout = layout_page(&page(vec![n, t]));
        let ps = paras(&layout);
        assert_eq!(text(ps[0]), "1.\tReduce manual work");
        assert!(ps[0].ind_first < 0.0);
    }

    #[test]
    fn centred_title_is_centred_and_a_heading() {
        // Body lines span x 50..550, so the column centre is 300.
        let title = line("Big Title", 255.0, 60.0, 20.0, 0);
        let body: Vec<TextLine> = (0..5).map(|i| line(&"body text ".repeat(10), 50.0, 100.0 + i as f32 * 30.0, 10.0, i + 1)).collect();
        let mut lines = vec![title];
        lines.extend(body);
        let layout = layout_page(&page(lines));
        let ps = paras(&layout);
        assert_eq!(ps[0].align, Align::Center);
        assert_eq!(ps[0].heading, Some(1));
        assert_eq!(ps[1].heading, None);
    }

    #[test]
    fn underline_rule_marks_glyphs_and_is_not_a_table() {
        let mut m = page(vec![line("under", 50.0, 100.0, 10.0, 0)]);
        m.rules.push(Rect::new(50.0, 101.0, 75.0, 101.8));
        let layout = layout_page(&m);
        let ps = paras(&layout);
        assert!(ps[0].runs.iter().all(|r| r.style.underline));
        assert_eq!(layout.tables, 0);
    }

    #[test]
    fn ruled_grid_becomes_table_with_span() {
        // 3 columns x 2 rows; the second row's inner borders are missing → one cell spanning 3.
        let mut m = page(vec![
            line("A", 105.0, 115.0, 10.0, 0),
            line("B", 205.0, 115.0, 10.0, 0),
            line("C", 305.0, 115.0, 10.0, 0),
            line("Total", 105.0, 135.0, 10.0, 1),
        ]);
        m.rules = vec![
            Rect::new(100.0, 99.8, 400.0, 100.2),
            Rect::new(100.0, 119.8, 400.0, 120.2),
            Rect::new(100.0, 139.8, 400.0, 140.2),
            Rect::new(99.8, 100.0, 100.2, 140.0),
            Rect::new(399.8, 100.0, 400.2, 140.0),
            Rect::new(199.8, 100.0, 200.2, 120.0),
            Rect::new(299.8, 100.0, 300.2, 120.0),
        ];
        let layout = layout_page(&m);
        assert_eq!(layout.tables, 1);
        let table = layout.bands[0].columns[0].items.iter().find_map(|i| if let Item::Table(t) = i { Some(t) } else { None }).unwrap();
        assert_eq!(table.cols.len(), 3);
        assert_eq!(table.rows[0].cells.len(), 3);
        assert_eq!(table.rows[1].cells.len(), 1);
        assert_eq!(table.rows[1].cells[0].span, 3);
        assert!(paras(&layout).is_empty(), "table text must not repeat outside the table");
    }

    #[test]
    fn two_columns_are_detected() {
        let mut lines = Vec::new();
        for i in 0..10 {
            let y = 100.0 + i as f32 * 14.0;
            lines.push(line("left column text that fills the line", 50.0, y, 10.0, 0));
            lines.push(line("right column text fills it as well", 320.0, y, 10.0, 1));
        }
        let layout = layout_page(&page(lines));
        assert_eq!(layout.bands.len(), 1);
        assert_eq!(layout.bands[0].columns.len(), 2);
        let left: String = layout.bands[0].columns[0].items.iter().filter_map(|i| if let Item::Para(p) = i { Some(text(p)) } else { None }).collect();
        assert!(left.contains("left column") && !left.contains("right column"));
    }

    #[test]
    fn borderless_table_is_not_columns() {
        let mut lines = Vec::new();
        for i in 0..10 {
            let y = 100.0 + i as f32 * 14.0;
            lines.push(line("cell text in the first column", 50.0, y, 10.0, i));
            lines.push(line("cell text in second column", 320.0, y, 10.0, i));
        }
        let layout = layout_page(&page(lines));
        assert_eq!(layout.bands[0].columns.len(), 1);
    }
}
