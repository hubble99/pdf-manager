"""Optional bounded dependencies for the native uniform-backdrop certificate.

This is not a backdrop classifier. Native geometry, order, exact correspondence,
marked graphics-state ownership and both artifacts are mandatory in the worker.
"""
from pypdf.generic import ArrayObject, BooleanObject, DictionaryObject, StreamObject, NumberObject
from features.edit_content.marked_content import require, numbers
from features.edit_content.preservation import semantic_hash, optional_proof


def false_or_absent(mapping, key):
    return key not in mapping or (isinstance(mapping[key], BooleanObject) and not mapping[key].value)


def zero_soft_mask(image):
    image = image.get_object()
    allowed = {'/Type', '/Subtype', '/Width', '/Height', '/BitsPerComponent',
        '/ColorSpace', '/Interpolate', '/SMask', '/Length', '/Filter', '/DecodeParms'}
    require(isinstance(image, StreamObject) and set(image) <= allowed)
    require(image.get('/Type', '/XObject') == '/XObject' and image.get('/Subtype') == '/Image')
    require(image.get('/ColorSpace') == '/DeviceRGB' and image.get('/BitsPerComponent') == 8)
    require(false_or_absent(image, '/Interpolate'))
    width, height = image['/Width'], image['/Height']
    require(isinstance(width, NumberObject) and isinstance(height, NumberObject))
    require(width > 0 and height > 0 and width * height * 3 <= 64 * 1024 * 1024)
    mask = image['/SMask']
    require(isinstance(mask, StreamObject) and set(mask) <= (allowed - {'/SMask'}) | {'/Matte', '/Decode'})
    require(mask.get('/Type', '/XObject') == '/XObject' and mask.get('/Subtype') == '/Image')
    require(mask.get('/ColorSpace') == '/DeviceGray' and mask.get('/BitsPerComponent') == 8)
    require(mask.get('/Width') == width and mask.get('/Height') == height)
    require(false_or_absent(mask, '/Interpolate') and list(mask.get('/Decode', [0, 1])) == [0, 1])
    # Exclude JPX intrinsic alpha and all other decoder-specific paint semantics.
    require(image.get('/Filter', '/FlateDecode') == '/FlateDecode'
        and mask.get('/Filter', '/FlateDecode') == '/FlateDecode')
    if '/Matte' in mask:
        numbers(mask['/Matte'], 3)
        require(all(0 <= v <= 1 for v in mask['/Matte']))
    data = mask.get_data()
    require(isinstance(data, bytes) and len(data) == width * height and not any(data))
    # Zero alpha makes even a preblended Matte color non-painting, but only under
    # the worker's Normal/non-knockout proof; it is never a global image exemption.
    return semantic_hash(image)


def backdrop_context(page, resources):
    require(set(page) <= {'/Type', '/Parent', '/Resources', '/Contents', '/MediaBox',
        '/CropBox', '/Rotate', '/Group', '/Annots', '/Tabs', '/StructParents'})
    require(page.get('/Rotate', 0) == 0)
    if '/Group' in page:
        group = page['/Group']
        require(isinstance(group, DictionaryObject) and set(group) <= {'/Type', '/S', '/CS', '/I', '/K'})
        require(group.get('/Type', '/Group') == '/Group' and group.get('/S') == '/Transparency')
        require(group.get('/CS') == '/DeviceRGB')
        require(false_or_absent(group, '/I') and false_or_absent(group, '/K'))
    annotations = page.get('/Annots', ArrayObject()).get_object()
    require(isinstance(annotations, ArrayObject) and len(annotations) <= 256)
    rectangles = []
    for raw in annotations:
        annot = raw.get_object()
        require(isinstance(annot, DictionaryObject))
        require(set(annot) <= {'/Type', '/Subtype', '/Rect', '/BS', '/F', '/A'})
        require(annot.get('/Type', '/Annot') == '/Annot' and annot.get('/Subtype') == '/Link')
        require(annot.get('/F', 0) in (0, 4))
        border = annot.get('/BS', {}).get_object() if '/BS' in annot else {}
        require(set(border) == {'/W'} and border['/W'] == 0)
        if '/A' in annot:
            action = annot['/A']
            require(set(action) <= {'/Type', '/S', '/URI'} and action.get('/S') == '/URI')
            require(action.get('/Type', '/Action') == '/Action' and isinstance(action.get('/URI'), str))
        rect = annot['/Rect']; numbers(rect, 4)
        require(rect[0] < rect[2] and rect[1] < rect[3])
        rectangles.append([float(v) for v in rect])
    images = resources.get('/XObject', DictionaryObject()).get_object()
    require(isinstance(images, DictionaryObject) and len(images) <= 256)
    empty = [proof for raw in images.values() if (proof := optional_proof(zero_soft_mask, raw)) is not None]
    require(len(empty) == len(set(empty)))
    return {'schema': 'uniform-backdrop-context/v1', 'annotationRects': rectangles,
        'zeroMaskImages': sorted(empty)}
