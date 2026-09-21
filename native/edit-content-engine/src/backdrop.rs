//! Bounded uniform field certificate; absence leaves ordinary layout in force.
//! Identity comes from complete verifier correspondence, never from paint order.
use super::{ObjectEvidence, Snapshot};
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn rect(points: &[[f64; 2]]) -> Option<[f64; 4]> {
    if points.len() != 4 || points.iter().flatten().any(|n| !n.is_finite()) { return None; }
    let mut r = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for p in points { r[0] = r[0].min(p[0]); r[1] = r[1].min(p[1]); r[2] = r[2].max(p[0]); r[3] = r[3].max(p[1]); }
    Some(r)
}

fn disjoint(a: [f64; 4], b: [f64; 4]) -> bool {
    a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]
}

fn contains(outer: [f64; 4], inner: [f64; 4]) -> bool {
    outer[0] < inner[0] && outer[1] < inner[1] && inner[2] < outer[2] && inner[3] < outer[3]
}

fn opaque_rectangle(object: &ObjectEvidence) -> Option<[f64; 4]> {
    if object.kind != "path" || object.style["matrix"] != json!([1.0,0.0,0.0,1.0,0.0,0.0])
        || object.style["clipPath"] != json!([]) || object.style["graphicsState"] != json!([1.0,1.0,"/Normal"])
        || object.style["fillColor"][3] != 255 || object.payload["stroked"] != false
        || !matches!(object.payload["fill"].as_str(), Some("EvenOdd" | "Winding")) { return None; }
    let segments = object.payload["segments"].as_array()?;
    if segments.len() != 5 || segments[0]["kind"] != "MoveTo" { return None; }
    let mut points = Vec::new();
    for (i, segment) in segments.iter().enumerate() {
        if segment["close"] != (i == 4) || (i > 0 && segment["kind"] != "LineTo") { return None; }
        let p = segment["point"].as_array()?;
        if p.len() != 2 { return None; }
        points.push([p[0].as_f64()?, p[1].as_f64()?]);
    }
    if points[0] != points[4] { return None; }
    let r = rect(&points[..4])?;
    if r[0] >= r[2] || r[1] >= r[3] { return None; }
    for edge in points.windows(2) {
        if (edge[0][0] == edge[1][0]) == (edge[0][1] == edge[1][1]) { return None; }
    }
    for p in &points[..4] {
        if !(p[0] == r[0] || p[0] == r[2]) || !(p[1] == r[1] || p[1] == r[3]) { return None; }
    }
    Some(r)
}

fn nonpainting(object: &ObjectEvidence, context: &Value) -> bool {
    if object.style["emptyGlyphPaint"] == "winansi-loca/v1" { return true; }
    object.kind == "image" && object.style["clipPath"] == json!([])
        && object.style["graphicsState"] == json!([1.0,1.0,"/Normal"])
        && context["zeroMaskImages"].as_array().is_some_and(|images|
            images.contains(&object.payload["resourceIdentity"]))
}

pub(super) fn preserved_order(before: &Snapshot, after: &Snapshot, mapping: &[(usize,usize)], page: u16) -> bool {
    let pairs=mapping.iter().filter(|(a,_)|before.objects[*a].page==page).collect::<Vec<_>>();
    !pairs.is_empty() && pairs.len()<=4096 && pairs.iter().enumerate().all(|(ordinal,(a,b))| {
        let a=&before.objects[*a];let b=&after.objects[*b];
        a.index==ordinal && b.index==ordinal && a.style==b.style && a.payload==b.payload
            && (a.kind=="text" || a.quad==b.quad)
    })
}

pub(super) fn passive_context(before: &Snapshot, after: &Snapshot, original: &ObjectEvidence) -> bool {
    let context=&before.pages[original.page as usize]["backdropContext"];
    let Some(region)=rect(&original.quad) else {return false;};
    context["schema"]=="uniform-backdrop-context/v1" && context==&after.pages[original.page as usize]["backdropContext"]
        && context["annotationRects"].as_array().is_some_and(|annotations| annotations.iter().all(|v| {
            let Some(v)=v.as_array() else {return false;};
            let Some(v)=v.iter().map(Value::as_f64).collect::<Option<Vec<_>>>() else {return false;};
            v.len()==4 && v.iter().all(|v|v.is_finite()) && disjoint([v[0],v[1],v[2],v[3]],region)
        }))
}

/// Returns baseline native indices insulated by ONE exact opaque rectangle.
/// The certificate is recomputed from both snapshots, after unique matching.
pub(super) fn certified(
    before: &Snapshot, after: &Snapshot, mapping: &[(usize, usize)], target: usize,
) -> Option<BTreeSet<usize>> {
    let original = before.objects.get(target)?;
    let changed = &after.objects[mapping.iter().find(|(a, _)| *a == target)?.1];
    let context = &before.pages.get(original.page as usize)?["backdropContext"];
    if context["schema"] != "uniform-backdrop-context/v1"
        || context != &after.pages.get(original.page as usize)?["backdropContext"]
        || original.style != changed.style || original.style["clipPath"] != json!([])
        || original.style["renderMode"] != "FilledUnstroked"
        || original.style["graphicsState"] != json!([1.0,1.0,"/Normal"])
        || original.style["fillColor"][3] != 255 { return None; }
    let a = rect(&original.quad)?; let b = rect(&changed.quad)?;
    if a[0] >= a[2] || a[1] >= a[3] || b[0] >= b[2] || b[1] >= b[3] { return None; }
    let region = [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])];
    for annotation in context["annotationRects"].as_array()? {
        let v = annotation.as_array()?;
        if v.len() != 4 { return None; }
        let r = [v[0].as_f64()?, v[1].as_f64()?, v[2].as_f64()?, v[3].as_f64()?];
        if r.iter().any(|n| !n.is_finite()) || !disjoint(r, region) { return None; }
    }
    let pairs = mapping.iter().filter(|(a, _)| before.objects[*a].page == original.page).collect::<Vec<_>>();
    if pairs.is_empty() || pairs.len() > 4096 { return None; }
    // Verify preserved painter order using the independently solved identities.
    // An ordinal never selects a corresponding object.
    if !preserved_order(before,after,mapping,original.page) { return None; }
    for (a, b) in &pairs {
        let background = &before.objects[*a];
        if background.index >= original.index { continue; }
        let Some(r) = opaque_rectangle(background) else { continue; };
        if !contains(r, region) || opaque_rectangle(&after.objects[*b]) != Some(r) { continue; }
        let mut covered = BTreeSet::new();
        let mut valid = true;
        for (old, new) in &pairs {
            let old = &before.objects[*old]; let new = &after.objects[*new];
            if old.index == original.index { continue; }
            if old.index <= background.index {
                covered.insert(old.index);
            } else if nonpainting(old, context) && nonpainting(new, context) {
                covered.insert(old.index);
            } else if !rect(&old.quad).zip(rect(&new.quad)).is_some_and(|(a,b)|
                disjoint(a, region) && disjoint(b, region)) {
                valid = false; break;
            }
        }
        if valid { return Some(covered); }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Snapshot, Snapshot, Vec<(usize, usize)>) {
        let context = json!({"schema":"uniform-backdrop-context/v1", "annotationRects":[[0,0,1,1]], "zeroMaskImages":["mask"]});
        let style = json!({"matrix":[1.0,0.0,0.0,1.0,0.0,0.0],"clipPath":[],
            "graphicsState":[1.0,1.0,"/Normal"],"fillColor":[255,255,255,255]});
        let path = ObjectEvidence {page:0,index:0,kind:"path".into(),text:None,paint_support:Value::Null,
            quad:vec![[10.0,10.0],[100.0,10.0],[100.0,100.0],[10.0,100.0]],style:style.clone(),
            payload:json!({"fill":"EvenOdd","stroked":false,"segments":[
                {"kind":"MoveTo","close":false,"point":[10.0,10.0]},
                {"kind":"LineTo","close":false,"point":[100.0,10.0]},
                {"kind":"LineTo","close":false,"point":[100.0,100.0]},
                {"kind":"LineTo","close":false,"point":[10.0,100.0]},
                {"kind":"LineTo","close":true,"point":[10.0,10.0]}]})};
        let mut image=path.clone(); image.index=1; image.kind="image".into();
        image.payload=json!({"resourceIdentity":"mask"});
        let mut target=path.clone(); target.index=2; target.kind="text".into();
        target.text=Some("A".into()); target.payload=Value::Null;
        target.style["renderMode"]=json!("FilledUnstroked");
        target.quad=vec![[20.0,20.0],[30.0,20.0],[30.0,30.0],[20.0,30.0]];
        let before=Snapshot{artifact_hash:"a".repeat(64),revision:0,pages:vec![json!({"backdropContext":context})],objects:vec![path,image,target]};
        let mut after=before.clone(); after.artifact_hash="b".repeat(64);
        after.objects[2].text=Some("AA".into()); after.objects[2].quad[1][0]=40.0; after.objects[2].quad[2][0]=40.0;
        (before,after,vec![(0,0),(1,1),(2,2)])
    }

    #[test]
    fn uniform_proof_requires_both_artifacts_and_unique_preserved_order() {
        let (before, after, map)=fixture();
        assert_eq!(certified(&before,&after,&map,2),Some(BTreeSet::from([0,1])));
        let mut reordered=after.clone();
        reordered.objects.swap(0,2); reordered.objects[0].index=0; reordered.objects[2].index=2;
        assert!(certified(&before,&reordered,&[(0,2),(1,1),(2,0)],2).is_none());
        for field in ["clipPath","graphicsState","fillColor"] {
            let mut bad=after.clone(); bad.objects[0].style[field]=Value::Null;
            assert!(certified(&before,&bad,&map,2).is_none());
        }
        let mut bad=after.clone(); bad.objects[0].payload["segments"][0]["point"][0]=json!(10.0000001);
        assert!(certified(&before,&bad,&map,2).is_none());
        let mut bad=after.clone(); bad.objects[1].payload["resourceIdentity"]=json!("different-mask");
        assert!(certified(&before,&bad,&map,2).is_none());
        let mut bad=after.clone(); bad.pages[0]["backdropContext"]=Value::Null;
        assert!(certified(&before,&bad,&map,2).is_none());
        assert!(certified(&before,&after,&[(0,0),(2,2)],2).is_none());
    }

    #[test]
    fn uniform_proof_rejects_common_foreground_mixed_and_boundary_conditions() {
        for failure in ["mask","annotation","foreground","alpha","clip","boundary"] {
            let (mut before,mut after,map)=fixture();
            for snapshot in [&mut before,&mut after] {
                match failure {
                    "mask" => snapshot.pages[0]["backdropContext"]["zeroMaskImages"]=json!([]),
                    "annotation" => snapshot.pages[0]["backdropContext"]["annotationRects"]=json!([[25,25,26,26]]),
                    "alpha" => snapshot.objects[0].style["graphicsState"]=json!([0.999999,1.0,"/Normal"]),
                    "clip" => snapshot.objects[0].style["clipPath"]=json!([{}]),
                    "boundary" => {snapshot.objects[2].quad[0][0]=10.0; snapshot.objects[2].quad[3][0]=10.0;},
                    "foreground" => {snapshot.objects[0].index=3;},
                    _ => unreachable!(),
                }
            }
            assert!(certified(&before,&after,&map,2).is_none(),"{failure}");
        }
    }
}
