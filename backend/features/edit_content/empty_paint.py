"""Optional, bounded proof of an empty embedded glyph, not whitespace policy.

The native worker must bind every serialized text slot to a unique actual object
using the already-proven dictionary ownership and exact transform/size/MCID.
"""
import io
import struct

from fontTools.ttLib import TTFont
from pypdf.generic import ByteStringObject, TextStringObject
from features.edit_content.marked_content import require, MAX_OPERATIONS


def empty_winansi_space(font):
    """Pinned TrueType mapping: WinAnsi code 32 -> Windows Unicode cmap U+0020.

    Equal loca offsets prove there are no glyph instructions or outlines. A null
    native glyph-path result, a glyph name, or zero bounds is not this proof.
    """
    font = font.get_object()
    if (font.get('/Subtype') != '/TrueType' or font.get('/Encoding') != '/WinAnsiEncoding'
            or '/ToUnicode' in font):
        return False
    desc = font.get('/FontDescriptor', {}).get_object() if '/FontDescriptor' in font else {}
    if desc.get('/Flags') != 32 or '/FontFile2' not in desc:
        return False
    data = desc['/FontFile2'].get_data()
    if not 0 < len(data) <= 16 * 1024 * 1024:
        return False
    with TTFont(io.BytesIO(data), lazy=False) as face:
        if any(t in face for t in ('CFF ', 'CFF2', 'fvar', 'gvar', 'COLR', 'CPAL', 'SVG ',
                'CBDT', 'CBLC', 'EBDT', 'EBLC', 'EBSC', 'bdat', 'bloc', 'sbix')):
            return False
        maps = [c for c in face['cmap'].tables if (c.platformID, c.platEncID) == (3, 1)]
        if len(maps) != 1 or maps[0].format != 4 or 32 not in maps[0].cmap:
            return False
        gid = face.getGlyphID(maps[0].cmap[32])
        # Do not depend on a library's choice between multiple Unicode cmaps.
        if any(c.isUnicode() and (32 not in c.cmap or face.getGlyphID(c.cmap[32]) != gid)
                for c in face['cmap'].tables):
            return False
        offsets = face['loca'].locations
        return (0 < gid < len(offsets) - 1 and
            0 <= offsets[gid] == offsets[gid + 1] <= face.reader.tables['glyf'].length)


def text_paint_slots(page, resources):
    """Represent only independent BT/Tm/show/ET slots with identity page CTM.

    Other text positioning grammars cannot establish this optional proof. The
    caller additionally requires the complete marked-content grammar and census.
    """
    ops = page.get_contents().operations
    require(len(ops) <= MAX_OPERATIONS)
    state = dict(font=None, size=None, ctm_identity=True, mode=0, rise=0, scale=100)
    stack, marks, slots, empty_fonts = [], [], [], {}
    matrix, painted, in_text = None, False, False
    f32 = lambda x: struct.unpack('<f', struct.pack('<f', float(x)))[0]
    bits = lambda x: struct.unpack('<I', struct.pack('<f', float(x)))[0]
    for args, op in ops:
        if op == b'q':
            stack.append(state.copy())
        elif op == b'Q':
            state = stack.pop()
        elif op == b'cm':
            # Nonidentity image transforms restored by Q are fine; text under
            # them is not supported. Never reconstruct a native CTM by rounding.
            state['ctm_identity'] &= list(args) == [1, 0, 0, 1, 0, 0]
        elif op == b'Tf':
            raw = resources['/Font'].raw_get(args[0])
            state.update(font=f'{raw.idnum}:{raw.generation}', size=f32(args[1]))
            if state['font'] not in empty_fonts:
                empty_fonts[state['font']] = empty_winansi_space(raw)
        elif op in (b'Tr', b'Ts', b'Tz'):
            state[{b'Tr': 'mode', b'Ts': 'rise', b'Tz': 'scale'}[op]] = float(args[0])
        elif op == b'BT':
            matrix, painted, in_text = None, False, True
        elif op == b'ET':
            in_text = False
        elif op == b'Tm':
            require(in_text and not painted)
            matrix = [f32(v) for v in args]
        elif op in (b'Td', b'TD', b'T*', b"'", b'"'):
            require(False)
        elif op in (b'BDC', b'BMC'):
            value = args[1] if op == b'BDC' else {}
            if isinstance(value, str):
                value = resources['/Properties'][value]
            marks.append(value.get('/MCID'))
        elif op == b'EMC':
            marks.pop()
        elif op in (b'Tj', b'TJ'):
            require(in_text and matrix is not None and not painted and state['ctm_identity'])
            require(state['scale'] == 100 and state['rise'] == 0)
            values = args[0] if op == b'TJ' else args
            # A leading TJ displacement changes the native object's starting
            # position; it is outside this exact Tm-slot proof.
            require(bool(values) and isinstance(values[0], (TextStringObject, ByteStringObject)) and len(values[0]) > 0)
            strings = [v.original_bytes if isinstance(v, TextStringObject) else bytes(v)
                for v in values if isinstance(v, (TextStringObject, ByteStringObject))]
            code_bytes = b''.join(strings)
            require(0 < len(code_bytes) <= 65536)
            slots.append(dict(mcid=next((m for m in marks if m is not None), -1),
                fontObject=state['font'], matrixBits=[bits(v) for v in matrix], fontSizeBits=bits(state['size']),
                emptyPaint=state['mode'] == 0 and code_bytes == b' ' and empty_fonts[state['font']]))
            painted = True
    return slots
