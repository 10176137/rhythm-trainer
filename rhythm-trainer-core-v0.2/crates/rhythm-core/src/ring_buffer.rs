use crate::CoreError;

/// Fixed-capacity FIFO ring buffer.
/// It is intentionally single-threaded; producers and consumers run on the same thread.
#[derive(Debug, Clone)]
pub struct RingBuffer<T> {
    slots: Vec<Option<T>>,
    head: usize,
    tail: usize,
    len: usize,
}

impl<T> RingBuffer<T> {
    pub fn new(capacity: usize) -> Result<Self, CoreError> {
        if capacity == 0 {
            return Err(CoreError::InvalidCapacity);
        }
        let slots = std::iter::repeat_with(|| None).take(capacity).collect();
        Ok(Self { slots, head: 0, tail: 0, len: 0 })
    }

    pub fn capacity(&self) -> usize { self.slots.len() }
    pub fn len(&self) -> usize { self.len }
    pub fn is_empty(&self) -> bool { self.len == 0 }
    pub fn is_full(&self) -> bool { self.len == self.capacity() }

    /// Returns the original value when full; it never overwrites queued data.
    pub fn push(&mut self, value: T) -> Result<(), T> {
        if self.is_full() {
            return Err(value);
        }
        self.slots[self.tail] = Some(value);
        self.tail = (self.tail + 1) % self.capacity();
        self.len += 1;
        Ok(())
    }

    pub fn pop(&mut self) -> Option<T> {
        if self.is_empty() {
            return None;
        }
        let value = self.slots[self.head].take();
        self.head = (self.head + 1) % self.capacity();
        self.len -= 1;
        value
    }

    pub fn drain(&mut self) -> Vec<T> {
        let mut result = Vec::with_capacity(self.len);
        while let Some(value) = self.pop() {
            result.push(value);
        }
        result
    }

    pub fn clear(&mut self) {
        while self.pop().is_some() {}
    }
}

#[cfg(test)]
mod tests {
    use super::RingBuffer;

    #[test]
    fn wraps_and_reuses_slots_fifo() {
        let mut q = RingBuffer::new(3).unwrap();
        q.push(1).unwrap();
        q.push(2).unwrap();
        q.push(3).unwrap();
        assert!(q.is_full());
        assert_eq!(q.pop(), Some(1));
        q.push(4).unwrap();
        assert_eq!(q.drain(), vec![2, 3, 4]);
        assert!(q.is_empty());
    }

    #[test]
    fn full_queue_does_not_overwrite() {
        let mut q = RingBuffer::new(1).unwrap();
        q.push("old").unwrap();
        assert_eq!(q.push("new"), Err("new"));
        assert_eq!(q.pop(), Some("old"));
    }

    #[test]
    fn zero_capacity_rejected() {
        assert!(RingBuffer::<u8>::new(0).is_err());
    }
}
