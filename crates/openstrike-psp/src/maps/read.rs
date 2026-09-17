//! Bounded file reads into permanent, initially uninitialized map storage.
use core::mem::MaybeUninit;

/// Read through EOF, returning the initialized prefix length. `read` must
/// initialize every byte it reports and return zero only at EOF.
pub(crate) fn read_into(
    buffer: &mut [MaybeUninit<u8>],
    mut read: impl FnMut(&mut [MaybeUninit<u8>]) -> Result<usize, &'static str>,
) -> Result<usize, &'static str> {
    let mut offset = 0;
    while offset < buffer.len() {
        let count = read(&mut buffer[offset..])?;
        if count > buffer.len() - offset {
            return Err("invalid map read length");
        }
        if count == 0 {
            return Ok(offset);
        }
        offset += count;
    }

    // A full buffer is valid when EOF follows. Probe into separate storage:
    // never write beyond the map allocation or accept a truncated larger file.
    let mut extra = [MaybeUninit::uninit()];
    match read(&mut extra)? {
        0 => Ok(offset),
        _ => Err("map larger than the map buffer"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn copy_reader<'a>(
        data: &'a [u8],
        chunk: usize,
    ) -> impl FnMut(&mut [MaybeUninit<u8>]) -> Result<usize, &'static str> + 'a {
        let mut offset = 0;
        move |target| {
            assert!(!target.is_empty(), "zero-length reads cannot establish EOF");
            let count = target.len().min(chunk).min(data.len() - offset);
            unsafe {
                core::ptr::copy_nonoverlapping(
                    data.as_ptr().add(offset),
                    target.as_mut_ptr().cast(),
                    count,
                );
            }
            offset += count;
            Ok(count)
        }
    }

    fn check(data: &[u8], capacity: usize, chunk: usize, expected: Result<usize, &'static str>) {
        let mut storage = vec![MaybeUninit::new(0xa5); capacity + 2];
        let result = read_into(&mut storage[1..=capacity], copy_reader(data, chunk));
        assert_eq!(result, expected);
        assert_eq!(unsafe { storage[0].assume_init() }, 0xa5);
        assert_eq!(unsafe { storage[capacity + 1].assume_init() }, 0xa5);
        if let Ok(size) = result {
            let bytes =
                unsafe { core::slice::from_raw_parts(storage[1..].as_ptr().cast::<u8>(), size) };
            assert_eq!(bytes, data);
        }
    }

    #[test]
    fn exact_aligned_capacity_is_not_overflow() {
        check(&[7; 32], 32, usize::MAX, Ok(32));
    }

    #[test]
    fn exact_capacity_with_short_reads() {
        check(&[9; 33], 33, 7, Ok(33));
    }

    #[test]
    fn smaller_file_stops_at_eof() {
        check(b"short map", 32, 3, Ok(9));
    }

    #[test]
    fn extra_byte_rejects_file_without_overwriting_buffer() {
        check(&[3; 33], 32, 5, Err("map larger than the map buffer"));
    }

    #[test]
    fn empty_file_and_zero_capacity() {
        check(&[], 0, 1, Ok(0));
        check(&[], 16, 1, Ok(0));
        check(&[1], 0, 1, Err("map larger than the map buffer"));
    }

    #[test]
    fn read_failure_after_partial_data_is_propagated() {
        let mut storage = [MaybeUninit::uninit(); 32];
        let mut calls = 0;
        assert_eq!(
            read_into(&mut storage, |target| {
                calls += 1;
                if calls == 1 {
                    target[0].write(7);
                    Ok(1)
                } else {
                    Err("map read failed")
                }
            }),
            Err("map read failed")
        );
    }

    #[test]
    fn eof_probe_failure_is_not_success() {
        let mut storage = [MaybeUninit::uninit(); 16];
        let mut calls = 0;
        assert_eq!(
            read_into(&mut storage, |target| {
                calls += 1;
                if calls == 1 {
                    for byte in target.iter_mut() {
                        byte.write(7);
                    }
                    Ok(target.len())
                } else {
                    Err("map read failed")
                }
            }),
            Err("map read failed")
        );
    }

    #[test]
    fn reusable_storage_does_not_expose_previous_map_tail() {
        let mut storage = [MaybeUninit::uninit(); 32];
        assert_eq!(read_into(&mut storage, copy_reader(&[7; 32], 8)), Ok(32));
        assert_eq!(read_into(&mut storage, copy_reader(b"next", 3)), Ok(4));
        let bytes = unsafe { core::slice::from_raw_parts(storage.as_ptr().cast::<u8>(), 4) };
        assert_eq!(bytes, b"next");
    }

    #[test]
    fn original_large_map_size_and_one_byte_overflow() {
        let data = vec![0x5a; 18_200_001];
        check(&data, data.len(), 65536, Ok(data.len()));
        check(
            &data,
            data.len() - 1,
            65536,
            Err("map larger than the map buffer"),
        );
    }

    #[test]
    fn invalid_read_count_is_rejected() {
        let mut storage = [MaybeUninit::uninit(); 16];
        assert_eq!(
            read_into(&mut storage, |_| Ok(17)),
            Err("invalid map read length")
        );
    }
}
