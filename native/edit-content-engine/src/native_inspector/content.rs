//! Page content as a list of operations, read the way pypdf's `ContentStream`
//! reads it. Inline images are not parsed: a stream that has one is refused
//! (pypdf's marked-content and image proofs refuse it too, and the paint-slot
//! proof is optional).

use super::filters;
use super::pdf::{is_delim, is_ws, reject, Dict, Lexer, Obj, PResult, Pdf, Reject};

pub const MAX_OPERATOR_LENGTH: usize = 128;

#[derive(Debug, Clone)]
pub struct Op {
    pub args: Vec<Obj>,
    pub op: Vec<u8>,
}

/// `page.get_contents()` parsed. `Ok(None)` when the page has no contents.
pub fn page_operations(pdf: &Pdf, page: &Dict) -> PResult<Option<Vec<Op>>> {
    let Some(value) = page.get("/Contents") else { return Ok(None) };
    let contents = pdf.resolve(value)?;
    let data = match &contents {
        Obj::Null => return Ok(None),
        Obj::Stream(stream) => filters::decode_stream(pdf, stream)?,
        Obj::Array(items) => {
            let mut data = Vec::new();
            for item in items.iter() {
                match pdf.resolve(item)? {
                    Obj::Null => continue,
                    Obj::Stream(stream) => {
                        data.extend(filters::decode_stream(pdf, &stream)?);
                        data.push(b'\n');
                    }
                    _ => reject!("contents entry is not a stream"),
                }
                if data.len() > filters::MAX_OUTPUT {
                    reject!("contents too large");
                }
            }
            data
        }
        _ => reject!("contents is not a stream"),
    };
    parse_operations(&data).map(Some)
}

pub fn parse_operations(data: &[u8]) -> PResult<Vec<Op>> {
    let mut lx = Lexer::new(data, 0);
    let mut operations = Vec::new();
    let mut operands: Vec<Obj> = Vec::new();
    loop {
        lx.skip_ws();
        let Some(first) = lx.peek() else { break };
        if first.is_ascii_alphabetic() || first == b'\'' || first == b'"' {
            let start = lx.pos;
            while lx.peek().is_some_and(|b| !is_ws(b) && !is_delim(b)) {
                lx.pos += 1;
            }
            let op = &data[start..lx.pos];
            if op.len() >= MAX_OPERATOR_LENGTH {
                reject!("operator too long");
            }
            if op == b"BI" {
                reject!("inline image");
            }
            operations.push(Op { args: std::mem::take(&mut operands), op: op.to_vec() });
        } else {
            let value = lx.parse_object(0)?;
            if matches!(value, Obj::Ref(..)) {
                reject!("reference in content");
            }
            operands.push(value);
        }
        if operations.len() > 4_000_000 {
            reject!("too many operations");
        }
    }
    // Operands left over at the end belong to no operator; pypdf drops them.
    if !operands.is_empty() {
        return Err(Reject("operands without an operator"));
    }
    Ok(operations)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operations_carry_their_operands() {
        let ops = parse_operations(b"q 1 0 0 1 10 20 cm /F1 12 Tf BT (Hi) Tj ET % note\nQ").unwrap();
        let names: Vec<_> = ops.iter().map(|o| String::from_utf8_lossy(&o.op).into_owned()).collect();
        assert_eq!(names, ["q", "cm", "Tf", "BT", "Tj", "ET", "Q"]);
        assert_eq!(ops[1].args.len(), 6);
        assert_eq!(ops[2].args[0], Obj::Name("/F1".into()));
    }

    #[test]
    fn broken_content_is_refused() {
        assert!(parse_operations(b"BI /W 1 ID x EI").is_err());
        assert!(parse_operations(b"1 2 3").is_err());
        assert!(parse_operations(b"1 0 R Do").is_err());
        assert!(parse_operations(b"[ 1 2").is_err());
    }
}
