use crate::model::ZipEntryInput;
use std::sync::OnceLock;

fn crc32_table() -> &'static [u32; 256] {
    static TABLE: OnceLock<[u32; 256]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for (i, slot) in t.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if (c & 1) != 0 {
                    0xEDB8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
            *slot = c;
        }
        t
    })
}

/// Standard IEEE 802.3 CRC-32.
pub fn crc32(bytes: &[u8]) -> u32 {
    let table = crc32_table();
    let mut c = 0xFFFF_FFFFu32;
    for &b in bytes {
        c = table[((c ^ (b as u32)) & 0xFF) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

/// Pure-Rust PKWARE ZIP archive builder (STORE method 0, UTF-8 EFS flag 0x0800).
pub fn build_zip_store(entries: &[ZipEntryInput]) -> Vec<u8> {
    // Fixed deterministic DOS timestamp (2025-01-01 00:00:00) for reproducible archive output
    let dos_time: u16 = 0;
    let dos_date: u16 = ((2025 - 1980) << 9) | (1 << 5) | 1;

    struct Prepared<'a> {
        name_bytes: &'a [u8],
        data: &'a [u8],
        crc: u32,
        offset: u32,
    }

    let mut prepared = Vec::with_capacity(entries.len());
    let mut local_size: usize = 0;
    let mut cd_size: usize = 0;

    for ent in entries {
        let name_bytes = ent.name.as_bytes();
        let data = ent.data.as_slice();
        let offset = local_size as u32;
        local_size += 30 + name_bytes.len() + data.len();
        cd_size += 46 + name_bytes.len();
        prepared.push(Prepared {
            name_bytes,
            data,
            crc: crc32(data),
            offset,
        });
    }

    let total_size = local_size + cd_size + 22;
    let mut out = Vec::with_capacity(total_size);

    // Local File Headers + File Data
    for item in &prepared {
        out.extend_from_slice(&0x0403_4B50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 filename flag
        out.extend_from_slice(&0u16.to_le_bytes()); // STORE method 0
        out.extend_from_slice(&dos_time.to_le_bytes());
        out.extend_from_slice(&dos_date.to_le_bytes());
        out.extend_from_slice(&item.crc.to_le_bytes());
        out.extend_from_slice(&(item.data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(item.data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(item.name_bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(item.name_bytes);
        out.extend_from_slice(item.data);
    }

    let cd_offset = out.len() as u32;

    // Central Directory Headers
    for item in &prepared {
        out.extend_from_slice(&0x0201_4B50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0x0800u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&dos_time.to_le_bytes());
        out.extend_from_slice(&dos_date.to_le_bytes());
        out.extend_from_slice(&item.crc.to_le_bytes());
        out.extend_from_slice(&(item.data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(item.data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(item.name_bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&item.offset.to_le_bytes());
        out.extend_from_slice(item.name_bytes);
    }

    // End of Central Directory Record
    let count = prepared.len() as u16;
    out.extend_from_slice(&0x0605_4B50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&(cd_size as u32).to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());

    out
}
