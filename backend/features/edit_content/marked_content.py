"""Bounded read-only marked-content constraints, never an editable object model.

These are candidate sets, not native ownership. The worker must independently
bind native MCIDs/font handles, prove a unique bijection and check every census.
"""
import math

from pypdf.generic import (ArrayObject, ByteStringObject, DictionaryObject,
    IndirectObject, NameObject, NumberObject, TextStringObject)
from features.edit_content.preservation import UnprovenPreservation, resource_fingerprints


MAX_OPERATIONS = 100_000
MAX_DEPTH = 64
MAX_FONTS = 64
NUMERIC = {b'cm': 6, b'Tm': 6, b'Td': 2, b'TD': 2, b'Tc': 1, b'Tw': 1,
    b'Tz': 1, b'TL': 1, b'Tr': 1, b'Ts': 1, b'w': 1, b'J': 1, b'j': 1,
    b'M': 1, b'i': 1, b'g': 1, b'G': 1, b'rg': 3, b'RG': 3, b'k': 4, b'K': 4}
PATH = {b'm': 2, b'l': 2, b'c': 6, b'v': 4, b'y': 4, b're': 4}
PAINT = {b'S', b's', b'f', b'F', b'f*', b'B', b'B*', b'b', b'b*'}


def require(condition):
    if not condition:
        raise UnprovenPreservation('marked-content proof is incomplete')


def numbers(args, count):
    require(len(args) == count)
    require(all(isinstance(v, (int, float)) and not isinstance(v, bool)
        and math.isfinite(float(v)) for v in args))


def marked_content_proof(page, resources):
    resources = resources.get_object()
    require(isinstance(resources, DictionaryObject))
    # Nested/inline/opaque content cannot inherit a guessed outer ownership.
    for image in resources.get('/XObject', {}).get_object().values() if '/XObject' in resources else ():
        require(image.get_object().get('/Subtype') == '/Image')
    states = {}
    for name, value in resources.get('/ExtGState', {}).items():
        value = value.get_object()
        require(isinstance(value, DictionaryObject))
        require(set(value) <= {'/Type', '/ca', '/CA', '/BM'})
        require(value.get('/Type', '/ExtGState') == '/ExtGState')
        require(value.get('/BM', '/Normal') == '/Normal')
        state = {}
        for key in ('/ca', '/CA'):
            if key in value:
                numbers([value[key]], 1)
                require(0 <= float(value[key]) <= 1)
                state[key] = float(value[key])
        states[str(name)] = state
    contents = page.get_contents()
    require(contents is not None and len(contents.operations) <= MAX_OPERATIONS)
    font, alpha, stroke = None, 1.0, 1.0
    graphics, marks, groups = [], [], {}
    in_text, path_pending, seen_mark = False, False, False
    used_fonts = set()
    selected_fonts = set()

    def paint(kind):
        mcid = next((m for m in marks if m is not None), -1)
        key = (mcid, kind)
        group = groups.setdefault(key, {'mcid': mcid, 'kind': kind, 'count': 0,
            'fonts': set(), 'states': []})
        group['count'] += 1
        if kind == 1:
            require(font is not None)
            group['fonts'].add(font)
            used_fonts.add(font)
            require(len(used_fonts) <= MAX_FONTS)
        state = [alpha, stroke, '/Normal']
        # Two distinct values are sufficient to make the group unprovable.
        if len(group['states']) < 2 and state not in group['states']:
            group['states'].append(state)

    for args, op in contents.operations:
        if op in NUMERIC:
            numbers(args, NUMERIC[op])
        elif op in PATH:
            numbers(args, PATH[op])
            require(not in_text and (path_pending or op in (b'm', b're')))
            path_pending = True
        elif op == b'h':
            require(not args and path_pending)
        elif op in PAINT or op == b'n':
            require(not args and not in_text)
            if op in PAINT:
                require(path_pending)
                paint(2)
            path_pending = False
        elif op in (b'W', b'W*'):
            require(not args and path_pending)
        elif op in (b'q', b'Q'):
            require(not args and not path_pending)
            if op == b'q':
                require(len(graphics) < MAX_DEPTH)
                graphics.append((font, alpha, stroke))
            else:
                require(bool(graphics))
                font, alpha, stroke = graphics.pop()
        elif op == b'gs':
            require(len(args) == 1 and isinstance(args[0], NameObject) and str(args[0]) in states)
            value = states[str(args[0])]
            alpha, stroke = value.get('/ca', alpha), value.get('/CA', stroke)
        elif op == b'Tf':
            require(len(args) == 2 and isinstance(args[0], NameObject))
            numbers(args[1:], 1)
            mapping = resources.get('/Font', {})
            require(args[0] in mapping)
            raw = mapping.raw_get(args[0])
            require(isinstance(raw, IndirectObject))
            dictionary = raw.get_object()
            require(isinstance(dictionary, DictionaryObject))
            require(dictionary.get('/Subtype') in ('/Type1', '/TrueType', '/Type0'))
            font = f'{raw.idnum}:{raw.generation}'
            selected_fonts.add(font)
            require(len(selected_fonts) <= MAX_FONTS)
        elif op in (b'BT', b'ET'):
            require(not args and not path_pending and in_text == (op == b'ET'))
            in_text = op == b'BT'
        elif op == b'T*':
            require(not args and in_text)
        elif op in (b'Tj', b'TJ', b"'", b'"'):
            require(in_text)
            if op == b'"':
                require(len(args) == 3)
                numbers(args[:2], 2)
                values = args[2:]
            elif op == b'TJ':
                require(len(args) == 1 and isinstance(args[0], ArrayObject))
                values = args[0]
            else:
                require(len(args) == 1)
                values = args
            require(all(isinstance(v, (ByteStringObject, TextStringObject)) or
                (op == b'TJ' and isinstance(v, (int, float)) and math.isfinite(float(v))) for v in values))
            require(any(isinstance(v, (ByteStringObject, TextStringObject)) and len(v) for v in values))
            paint(1)
        elif op == b'Do':
            require(not in_text and not path_pending and len(args) == 1 and isinstance(args[0], NameObject))
            require(args[0] in resources.get('/XObject', {}))
            paint(3)
        elif op in (b'BDC', b'BMC'):
            require(not path_pending and len(marks) < MAX_DEPTH)
            require(len(args) == (2 if op == b'BDC' else 1) and isinstance(args[0], NameObject))
            require(args[0] != '/OC')
            mcid = None
            if op == b'BDC':
                value = args[1]
                if isinstance(value, NameObject):
                    value = resources['/Properties'][value]
                require(isinstance(value, DictionaryObject))
                # Only passive language/pagination metadata may accompany an
                # MCID. Text/visibility overrides need a different proof.
                require(set(value) <= {'/MCID', '/Lang', '/Type', '/Subtype', '/Attached'})
                if '/Lang' in value:
                    require(isinstance(value['/Lang'], TextStringObject) and len(value['/Lang']) <= 128)
                if set(value) & {'/Type', '/Subtype', '/Attached'}:
                    require(args[0] == '/Artifact' and value.get('/Type') == '/Pagination')
                    require(value.get('/Subtype') in ('/Header', '/Footer'))
                    attached = value.get('/Attached', ArrayObject())
                    require(isinstance(attached, ArrayObject) and len(attached) <= 4 and
                        all(isinstance(v, NameObject) and v in ('/Top', '/Bottom', '/Left', '/Right') for v in attached))
                if '/MCID' in value:
                    mcid = value['/MCID']
                    require(isinstance(mcid, NumberObject) and 0 <= mcid <= 2**31 - 1)
                    require(all(m is None for m in marks))
                    seen_mark = True
            marks.append(mcid)
        elif op == b'EMC':
            require(not args and bool(marks) and not path_pending)
            marks.pop()
        elif op == b'd':
            require(len(args) == 2 and isinstance(args[0], ArrayObject))
            numbers(list(args[0]) + [args[1]], len(args[0]) + 1)
        elif op == b'ri':
            require(len(args) == 1 and isinstance(args[0], NameObject))
        else:
            raise UnprovenPreservation('operator outside marked-content proof grammar')
    require(not graphics and not marks and not in_text and not path_pending and seen_mark)
    # A failed Tf load can leave the previous font active in PDFium. Account for
    # every selected dictionary, including an unpainted predecessor, so such a
    # fallback cannot masquerade as a complete native/dictionary bijection.
    require(selected_fonts == used_fonts)
    result = []
    for group in groups.values():
        states_for_group = group.pop('states')
        group['state'] = states_for_group[0] if len(states_for_group) == 1 else None
        group['fonts'] = sorted(group['fonts'])
        result.append(group)
    # This resource proof is unusable without the worker's all-object state binding.
    rest = DictionaryObject({k: v for k, v in resources.items() if k != '/ExtGState'})
    return {'schema': 'marked-content-constraints/v1', 'groups': result,
        'resources': resource_fingerprints(rest)}
