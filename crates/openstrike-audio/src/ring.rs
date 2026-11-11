//! A bounded single-producer single-consumer ring: the game's commands on their way to the audio thread, and the
//! mixed samples on their way to the WAV writer. Neither side ever waits for the other.

use std::cell::UnsafeCell;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

pub(crate) struct Ring<T> {
    buf: Box<[UnsafeCell<T>]>,
    mask: usize,
    /// Next slot to write (producer) and to read (consumer); they only ever grow, and wrap by the mask.
    head: AtomicUsize,
    tail: AtomicUsize,
    /// Producers take turns through this; the consumer never touches it.
    producer: Mutex<()>,
}

// One producer at a time writes slots the consumer has not been told about yet (`head` is published after the
// write); the consumer reads only slots below `head`.
unsafe impl<T: Send> Send for Ring<T> {}
unsafe impl<T: Send> Sync for Ring<T> {}

impl<T: Copy + Default> Ring<T> {
    pub fn new(capacity: usize) -> Ring<T> {
        let cap = capacity.next_power_of_two();
        Ring {
            buf: (0..cap).map(|_| UnsafeCell::new(T::default())).collect(),
            mask: cap - 1,
            head: AtomicUsize::new(0),
            tail: AtomicUsize::new(0),
            producer: Mutex::new(()),
        }
    }

    /// Appends as many of `items` as fit, and says how many that was. Any thread; a short lock among producers only.
    pub fn push(&self, items: &[T]) -> usize {
        let _turn = self.producer.lock().unwrap_or_else(|e| e.into_inner());
        self.push_unshared(items)
    }

    /// `push` for the one thread that is this ring's only producer (the audio thread feeding the WAV writer): no
    /// lock at all.
    pub fn push_unshared(&self, items: &[T]) -> usize {
        let head = self.head.load(Ordering::Relaxed);
        let free = self.buf.len() - head.wrapping_sub(self.tail.load(Ordering::Acquire));
        let n = items.len().min(free);
        for (i, item) in items[..n].iter().enumerate() {
            unsafe { *self.buf[head.wrapping_add(i) & self.mask].get() = *item };
        }
        self.head.store(head.wrapping_add(n), Ordering::Release);
        n
    }

    /// Takes the oldest item. One consumer thread only.
    pub fn pop(&self) -> Option<T> {
        let tail = self.tail.load(Ordering::Relaxed);
        if tail == self.head.load(Ordering::Acquire) {
            return None;
        }
        let item = unsafe { *self.buf[tail & self.mask].get() };
        self.tail.store(tail.wrapping_add(1), Ordering::Release);
        Some(item)
    }

    /// Takes up to `out.len()` items. One consumer thread only.
    pub fn pop_into(&self, out: &mut [T]) -> usize {
        let tail = self.tail.load(Ordering::Relaxed);
        let n = out
            .len()
            .min(self.head.load(Ordering::Acquire).wrapping_sub(tail));
        for (i, o) in out[..n].iter_mut().enumerate() {
            *o = unsafe { *self.buf[tail.wrapping_add(i) & self.mask].get() };
        }
        self.tail.store(tail.wrapping_add(n), Ordering::Release);
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn fills_wraps_and_refuses_overflow() {
        let ring = Ring::<u32>::new(8);
        assert_eq!(ring.pop(), None);
        assert_eq!(ring.push(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 8);
        assert_eq!(ring.push(&[11]), 0);
        let mut out = [0; 5];
        assert_eq!(ring.pop_into(&mut out), 5);
        assert_eq!(out, [1, 2, 3, 4, 5]);
        assert_eq!(ring.push_unshared(&[20, 21, 22, 23, 24, 25]), 5);
        let mut all = Vec::new();
        while let Some(x) = ring.pop() {
            all.push(x);
        }
        assert_eq!(all, [6, 7, 8, 20, 21, 22, 23, 24]);
    }

    #[test]
    fn many_producers_one_consumer_lose_nothing_and_keep_order() {
        let ring = Arc::new(Ring::<(u32, u32)>::new(64));
        let producers: Vec<_> = (0..4u32)
            .map(|id| {
                let ring = ring.clone();
                std::thread::spawn(move || {
                    for i in 0..20_000u32 {
                        while ring.push(&[(id, i)]) == 0 {
                            std::thread::yield_now();
                        }
                    }
                })
            })
            .collect();
        let mut next = [0u32; 4];
        let mut got = 0;
        while got < 80_000 {
            match ring.pop() {
                Some((id, i)) => {
                    assert_eq!(i, next[id as usize], "producer {id} out of order");
                    next[id as usize] += 1;
                    got += 1;
                }
                None => std::thread::yield_now(),
            }
        }
        for p in producers {
            p.join().unwrap();
        }
        assert_eq!(ring.pop(), None);
    }
}
