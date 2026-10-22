//! A streaming ZIP writer for already-compressed entries (PNG, JPEG, WEBP).
//!
//! Entries are stored, not deflated: image files do not shrink, and storing
//! keeps the writer simple and fast. Each entry's CRC and size are known when
//! its header is written, so nothing is patched afterwards. Archives past
//! 4 GiB use ZIP64 (offsets in the central directory, then a ZIP64 end
//! record), so a 1000-page export at print resolution still opens everywhere.

use std::io::{self, Write};
use std::time::{SystemTime, UNIX_EPOCH};

const U32_LIMIT: u64 = 0xFFFF_FFFF;
const U16_LIMIT: usize = 0xFFFF;

struct Entry {
    name: Vec<u8>,
    crc: u32,
    size: u64,
    offset: u64,
}

pub struct ZipWriter<W: Write> {
    out: W,
    written: u64,
    entries: Vec<Entry>,
    dos_time: u16,
    dos_date: u16,
    /// Offsets above this use ZIP64; lowered by tests.
    offset_limit: u64,
}

impl<W: Write> ZipWriter<W> {
    pub fn new(out: W) -> Self {
        let (dos_date, dos_time) = dos_now();
        Self { out, written: 0, entries: Vec::new(), dos_time, dos_date, offset_limit: U32_LIMIT - 1 }
    }

    #[cfg(test)]
    fn with_offset_limit(mut self, limit: u64) -> Self {
        self.offset_limit = limit;
        self
    }

    fn put(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.out.write_all(bytes)?;
        self.written += bytes.len() as u64;
        Ok(())
    }

    /// Appends one stored entry.
    pub fn add(&mut self, name: &str, data: &[u8]) -> io::Result<()> {
        if data.len() as u64 >= U32_LIMIT {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "an entry larger than 4 GiB cannot be stored"));
        }
        let name = name.as_bytes().to_vec();
        if name.len() > U16_LIMIT {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "entry name is too long"));
        }
        let crc = crc32fast::hash(data);
        let offset = self.written;
        let mut h = Vec::with_capacity(30 + name.len());
        h.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        h.extend_from_slice(&20u16.to_le_bytes()); // version needed
        h.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 names
        h.extend_from_slice(&0u16.to_le_bytes()); // stored
        h.extend_from_slice(&self.dos_time.to_le_bytes());
        h.extend_from_slice(&self.dos_date.to_le_bytes());
        h.extend_from_slice(&crc.to_le_bytes());
        h.extend_from_slice(&(data.len() as u32).to_le_bytes());
        h.extend_from_slice(&(data.len() as u32).to_le_bytes());
        h.extend_from_slice(&(name.len() as u16).to_le_bytes());
        h.extend_from_slice(&0u16.to_le_bytes()); // extra
        h.extend_from_slice(&name);
        self.put(&h)?;
        self.put(data)?;
        self.entries.push(Entry { name, crc, size: data.len() as u64, offset });
        Ok(())
    }

    /// Writes the central directory and returns the underlying writer.
    pub fn finish(mut self) -> io::Result<W> {
        let cd_start = self.written;
        let mut zip64 = false;
        let entries = std::mem::take(&mut self.entries);
        for e in &entries {
            let big = e.offset > self.offset_limit;
            zip64 |= big;
            let extra: Vec<u8> = if big {
                let mut x = Vec::new();
                x.extend_from_slice(&1u16.to_le_bytes());
                x.extend_from_slice(&8u16.to_le_bytes());
                x.extend_from_slice(&e.offset.to_le_bytes());
                x
            } else {
                Vec::new()
            };
            let mut c = Vec::with_capacity(46 + e.name.len() + extra.len());
            c.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            c.extend_from_slice(&(if big { 45u16 } else { 20 }).to_le_bytes()); // made by
            c.extend_from_slice(&(if big { 45u16 } else { 20 }).to_le_bytes()); // needed
            c.extend_from_slice(&0x0800u16.to_le_bytes());
            c.extend_from_slice(&0u16.to_le_bytes());
            c.extend_from_slice(&self.dos_time.to_le_bytes());
            c.extend_from_slice(&self.dos_date.to_le_bytes());
            c.extend_from_slice(&e.crc.to_le_bytes());
            c.extend_from_slice(&(e.size as u32).to_le_bytes());
            c.extend_from_slice(&(e.size as u32).to_le_bytes());
            c.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
            c.extend_from_slice(&(extra.len() as u16).to_le_bytes());
            c.extend_from_slice(&0u16.to_le_bytes()); // comment
            c.extend_from_slice(&0u16.to_le_bytes()); // disk
            c.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
            c.extend_from_slice(&0u32.to_le_bytes()); // external attrs
            c.extend_from_slice(&(if big { U32_LIMIT as u32 } else { e.offset as u32 }).to_le_bytes());
            c.extend_from_slice(&e.name);
            c.extend_from_slice(&extra);
            self.put(&c)?;
        }
        let cd_size = self.written - cd_start;
        let count = entries.len();
        zip64 |= count >= U16_LIMIT || cd_start > U32_LIMIT - 1 || cd_size > U32_LIMIT - 1;
        if zip64 {
            let eocd64_at = self.written;
            let mut z = Vec::with_capacity(56 + 20);
            z.extend_from_slice(&0x0606_4b50u32.to_le_bytes());
            z.extend_from_slice(&44u64.to_le_bytes());
            z.extend_from_slice(&45u16.to_le_bytes());
            z.extend_from_slice(&45u16.to_le_bytes());
            z.extend_from_slice(&0u32.to_le_bytes());
            z.extend_from_slice(&0u32.to_le_bytes());
            z.extend_from_slice(&(count as u64).to_le_bytes());
            z.extend_from_slice(&(count as u64).to_le_bytes());
            z.extend_from_slice(&cd_size.to_le_bytes());
            z.extend_from_slice(&cd_start.to_le_bytes());
            z.extend_from_slice(&0x0706_4b50u32.to_le_bytes());
            z.extend_from_slice(&0u32.to_le_bytes());
            z.extend_from_slice(&eocd64_at.to_le_bytes());
            z.extend_from_slice(&1u32.to_le_bytes());
            self.put(&z)?;
        }
        let mut e = Vec::with_capacity(22);
        e.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        e.extend_from_slice(&0u16.to_le_bytes());
        e.extend_from_slice(&0u16.to_le_bytes());
        let (n, size, start) = if zip64 {
            (0xFFFFu16, U32_LIMIT as u32, U32_LIMIT as u32)
        } else {
            (count as u16, cd_size as u32, cd_start as u32)
        };
        e.extend_from_slice(&n.to_le_bytes());
        e.extend_from_slice(&n.to_le_bytes());
        e.extend_from_slice(&size.to_le_bytes());
        e.extend_from_slice(&start.to_le_bytes());
        e.extend_from_slice(&0u16.to_le_bytes());
        self.put(&e)?;
        self.out.flush()?;
        Ok(self.out)
    }
}

/// Current UTC time as MS-DOS (date, time) words.
fn dos_now() -> (u16, u16) {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let year = (y.clamp(1980, 2107) - 1980) as u16;
    let date = (year << 9) | ((m as u16) << 5) | d as u16;
    let time = (((rem / 3600) as u16) << 11) | ((((rem % 3600) / 60) as u16) << 5) | ((rem % 60) / 2) as u16;
    (date, time)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read};

    fn read_all(bytes: Vec<u8>) -> Vec<(String, Vec<u8>)> {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        (0..archive.len())
            .map(|i| {
                let mut f = archive.by_index(i).unwrap();
                let mut data = Vec::new();
                f.read_to_end(&mut data).unwrap();
                (f.name().unwrap().to_string(), data)
            })
            .collect()
    }

    #[test]
    fn entries_round_trip() {
        let mut z = ZipWriter::new(Vec::new());
        z.add("a_page0001.png", b"first").unwrap();
        z.add("b ü.png", &vec![7u8; 100_000]).unwrap();
        let bytes = z.finish().unwrap();
        let back = read_all(bytes);
        assert_eq!(back[0], ("a_page0001.png".to_string(), b"first".to_vec()));
        assert_eq!(back[1].0, "b ü.png");
        assert_eq!(back[1].1.len(), 100_000);
    }

    #[test]
    fn an_empty_archive_is_valid() {
        let bytes = ZipWriter::new(Vec::new()).finish().unwrap();
        assert_eq!(zip::ZipArchive::new(Cursor::new(bytes)).unwrap().len(), 0);
    }

    #[test]
    fn zip64_offsets_are_written_when_needed() {
        // Force ZIP64 for every entry past the first 50 bytes.
        let mut z = ZipWriter::new(Vec::new()).with_offset_limit(50);
        z.add("one.bin", &[1u8; 64]).unwrap();
        z.add("two.bin", &[2u8; 64]).unwrap();
        z.add("three.bin", &[3u8; 64]).unwrap();
        let bytes = z.finish().unwrap();
        let back = read_all(bytes);
        assert_eq!(back.len(), 3);
        assert_eq!(back[2].1, vec![3u8; 64]);
    }

    #[test]
    fn dos_date_is_plausible() {
        let (date, _) = dos_now();
        let year = 1980 + (date >> 9);
        assert!((2024..2100).contains(&year));
    }
}
