//! Oort's RaBitQ-style quantized dense index (CON-25), for `@oortmem/store-sqlite` through napi-rs.
//!
//! The store keeps the codes in SQLite (`memories_rq`, schema version 7) and computes them in
//! TypeScript (`src/rabitq.ts`); this crate only holds them in memory and scans them. Per vector it
//! keeps a 1-bit code (the signs of the rotated vector's residual from the index centroid, packed as
//! `vec_quantize_binary` packs, element i in bit i % 8 of byte i / 8) and three `f32` factors:
//!
//! - `a`: `|r| / (|v| f)`, which turns the code's inner product into a cosine,
//! - `b`: `1 / |v|`, for the centroid's part of the cosine,
//! - `e`: `(|r| / |v|) sqrt((1 - f^2) / f^2) / sqrt(W - 1)`, the estimate's standard error,
//!
//! where `v` is the int8 vector, `r` its rotated residual, `W` the code width and `f` the inner
//! product between the residual's direction and its code (RaBitQ's `<o_bar, o>`).
//!
//! A search quantizes the (rotated, unit) query to 4 bits per dimension, estimates every
//! vector's cosine with four popcounts per 64 dimensions, and returns the vectors whose upper bound
//! (`estimate + eps * sd`) reaches the k-th best lower bound: the only ones that can be in the exact
//! top k. The caller rescores them with their int8 vectors, best upper bound first, and stops
//! when the next upper bound falls below its k-th exact score.
//!
//! Every computation is in `f64`, in the same order as the TypeScript reference engine
//! (`TsRabitqIndex`), so both return the same candidates for the same inputs.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

/// Bits of query quantization (RaBitQ's asymmetric query: 4 bits against 1-bit codes).
pub const QUERY_BITS: u32 = 4;

/// An identity-like hasher for `u32` row ids (a multiply-shift mix): ids are dense integers.
#[derive(Default)]
pub struct RidHasher(u64);

impl Hasher for RidHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0 ^ b as u64).wrapping_mul(0x100000001b3);
        }
    }
    fn write_u32(&mut self, n: u32) {
        self.0 = (n as u64).wrapping_mul(0x9e3779b97f4a7c15);
    }
}

type RidMap = HashMap<u32, u32, BuildHasherDefault<RidHasher>>;

/// A query prepared for scanning: its 4-bit planes and the scalars the estimate needs.
pub struct Query {
    planes: Vec<u64>, // QUERY_BITS planes of `words` words each
    lo: f64,
    delta: f64,
    sum: f64,
}

/// What a search may match: a node, optionally a set of projects and an author, and optionally
/// an allowlist of row ids (the spatial filter, resolved by the caller).
pub struct Filter<'a> {
    pub node: u32,
    pub projects: Option<&'a [u32]>,
    pub author: Option<u32>,
    pub allow: Option<&'a [u32]>,
}

/// Makes room for `extra` more values. When that needs a new allocation, the values are copied
/// into it and the old allocation is zeroed before it is freed, so no code or factor is left
/// behind in freed memory (`Vec`'s own growth would leave the old copy as it was).
fn grow_zeroing<T: Copy + Default>(v: &mut Vec<T>, extra: usize) {
    if v.len() + extra <= v.capacity() {
        return;
    }
    let mut bigger = Vec::with_capacity((v.len() + extra).max(v.capacity() * 2).max(64));
    bigger.extend_from_slice(v);
    v.fill(T::default());
    *v = bigger;
}

/// The in-memory index: one slot per vector, removed by swapping the last slot in.
pub struct Index {
    width: usize,
    words: usize,
    codes: Vec<u64>,
    factors: Vec<f32>,
    rids: Vec<u32>,
    nodes: Vec<u32>,
    projects: Vec<u32>,
    authors: Vec<u32>,
    slot_of: RidMap,
}

impl Index {
    /// An empty index for codes of `width` bits (a power of two, at least 8).
    pub fn new(width: usize) -> Result<Index, String> {
        if width < 8 || !width.is_power_of_two() {
            return Err(format!("rabitq: width must be a power of two of at least 8, got {width}"));
        }
        Ok(Index {
            width,
            words: width.div_ceil(64),
            codes: Vec::new(),
            factors: Vec::new(),
            rids: Vec::new(),
            nodes: Vec::new(),
            projects: Vec::new(),
            authors: Vec::new(),
            slot_of: RidMap::default(),
        })
    }

    pub fn len(&self) -> usize {
        self.rids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rids.is_empty()
    }

    /// Bytes held by the index's arrays and map (capacity, not length).
    pub fn heap_bytes(&self) -> usize {
        self.codes.capacity() * 8
            + self.factors.capacity() * 4
            + (self.rids.capacity() + self.nodes.capacity() + self.projects.capacity() + self.authors.capacity()) * 4
            // hashbrown: one (u32, u32) bucket and one control byte per slot of capacity
            + self.slot_of.capacity() * 9
    }

    /// Inserts or replaces vectors: `codes` holds `width / 8` bytes per vector, `factors` three
    /// per vector (`a`, `b`, `e`).
    pub fn upsert(
        &mut self,
        rids: &[u32],
        nodes: &[u32],
        projects: &[u32],
        authors: &[u32],
        codes: &[u8],
        factors: &[f32],
    ) -> Result<(), String> {
        let n = rids.len();
        let bytes = self.width / 8;
        if nodes.len() != n || projects.len() != n || authors.len() != n {
            return Err("rabitq: upsert arrays differ in length".into());
        }
        if codes.len() != n * bytes || factors.len() != n * 3 {
            return Err(format!(
                "rabitq: upsert of {n} vectors needs {} code bytes and {} factors, got {} and {}",
                n * bytes,
                n * 3,
                codes.len(),
                factors.len()
            ));
        }
        for i in 0..n {
            // A zero vector has no direction and so no estimate (its error factor is infinite):
            // it is never held, and a vector rewritten as zero leaves the index.
            if !factors[i * 3..i * 3 + 3].iter().all(|f| f.is_finite()) {
                self.remove(&rids[i..i + 1]);
                continue;
            }
            let slot = match self.slot_of.get(&rids[i]) {
                Some(&s) => s as usize,
                None => {
                    let s = self.rids.len();
                    self.slot_of.insert(rids[i], s as u32);
                    self.rids.push(rids[i]);
                    self.nodes.push(0);
                    self.projects.push(0);
                    self.authors.push(0);
                    grow_zeroing(&mut self.codes, self.words);
                    grow_zeroing(&mut self.factors, 3);
                    self.codes.resize(self.codes.len() + self.words, 0);
                    self.factors.resize(self.factors.len() + 3, 0.0);
                    s
                }
            };
            self.nodes[slot] = nodes[i];
            self.projects[slot] = projects[i];
            self.authors[slot] = authors[i];
            let code = &codes[i * bytes..(i + 1) * bytes];
            let out = &mut self.codes[slot * self.words..(slot + 1) * self.words];
            for (w, word) in out.iter_mut().enumerate() {
                let mut x = 0u64;
                for k in 0..8 {
                    if let Some(&b) = code.get(w * 8 + k) {
                        x |= (b as u64) << (8 * k);
                    }
                }
                *word = x;
            }
            self.factors[slot * 3..slot * 3 + 3].copy_from_slice(&factors[i * 3..i * 3 + 3]);
        }
        Ok(())
    }

    /// Removes vectors (unknown ids are ignored). Their codes are overwritten by the slot moved
    /// into their place, or truncated away, so nothing of them stays in the arrays.
    pub fn remove(&mut self, rids: &[u32]) {
        for rid in rids {
            let Some(slot) = self.slot_of.remove(rid) else { continue };
            let slot = slot as usize;
            let last = self.rids.len() - 1;
            if slot != last {
                let moved = self.rids[last];
                self.rids[slot] = moved;
                self.nodes[slot] = self.nodes[last];
                self.projects[slot] = self.projects[last];
                self.authors[slot] = self.authors[last];
                self.codes.copy_within(last * self.words..(last + 1) * self.words, slot * self.words);
                self.factors.copy_within(last * 3..last * 3 + 3, slot * 3);
                self.slot_of.insert(moved, slot as u32);
            }
            // Zero the vacated tail before truncating: the allocation is reused, not freed.
            for w in &mut self.codes[last * self.words..(last + 1) * self.words] {
                *w = 0;
            }
            for f in &mut self.factors[last * 3..last * 3 + 3] {
                *f = 0.0;
            }
            self.rids.truncate(last);
            self.nodes.truncate(last);
            self.projects.truncate(last);
            self.authors.truncate(last);
            self.codes.truncate(last * self.words);
            self.factors.truncate(last * 3);
        }
    }

    /// Empties the index and zeroes the memory it held.
    pub fn clear(&mut self) {
        for w in self.codes.iter_mut() {
            *w = 0;
        }
        for f in self.factors.iter_mut() {
            *f = 0.0;
        }
        self.codes.clear();
        self.factors.clear();
        self.rids.clear();
        self.nodes.clear();
        self.projects.clear();
        self.authors.clear();
        self.slot_of.clear();
        self.codes.shrink_to_fit();
        self.factors.shrink_to_fit();
    }

    /// Quantizes a rotated, unit query (`width` values) to `QUERY_BITS` bits per dimension.
    pub fn prepare(&self, q: &[f64]) -> Result<Query, String> {
        if q.len() != self.width {
            return Err(format!("rabitq: query has {} values, index width is {}", q.len(), self.width));
        }
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        let mut sum = 0.0f64;
        for &x in q {
            if x < lo {
                lo = x;
            }
            if x > hi {
                hi = x;
            }
            sum += x;
        }
        let levels = ((1u32 << QUERY_BITS) - 1) as f64;
        let delta = (hi - lo) / levels;
        let mut planes = vec![0u64; QUERY_BITS as usize * self.words];
        if delta > 0.0 {
            for (i, &x) in q.iter().enumerate() {
                let u = ((x - lo) / delta + 0.5).floor().clamp(0.0, levels) as u32;
                for j in 0..QUERY_BITS as usize {
                    if u & (1 << j) != 0 {
                        planes[j * self.words + i / 64] |= 1u64 << (i % 64);
                    }
                }
            }
        }
        Ok(Query { planes, lo, delta: if delta > 0.0 { delta } else { 0.0 }, sum })
    }

    /// The estimate and standard error of slot `s`'s cosine with the query.
    #[inline]
    fn estimate(&self, q: &Query, cq: f64, s: usize) -> (f64, f64) {
        let code = &self.codes[s * self.words..(s + 1) * self.words];
        let mut acc: u64 = 0;
        let mut pop: u64 = 0;
        for (w, &c) in code.iter().enumerate() {
            pop += c.count_ones() as u64;
            for j in 0..QUERY_BITS as usize {
                acc += ((c & q.planes[j * self.words + w]).count_ones() as u64) << j;
            }
        }
        let wf = self.width as f64;
        let a = self.factors[s * 3] as f64;
        let b = self.factors[s * 3 + 1] as f64;
        let e = self.factors[s * 3 + 2] as f64;
        let sbq = q.delta * acc as f64 + q.lo * pop as f64;
        let ip = (2.0 * sbq - q.sum) / wf.sqrt();
        let est = cq * b + a * ip;
        let qe = a * q.delta;
        let sd = (e * e + qe * qe * pop as f64 / (3.0 * wf)).sqrt();
        (est, sd)
    }

    fn passes(&self, f: &Filter, s: usize) -> bool {
        self.nodes[s] == f.node
            && f.projects.is_none_or(|p| p.contains(&self.projects[s]))
            && f.author.is_none_or(|a| self.authors[s] == a)
    }

    /// The candidates for the exact top `k`: every vector passing `filter` whose upper bound
    /// reaches the k-th best lower bound, best upper bound first (ties by row id). `cq` is the
    /// query's inner product with the index centroid (both rotated, the query unit length).
    pub fn search(&self, q: &Query, cq: f64, k: usize, eps: f64, filter: &Filter) -> (Vec<u32>, Vec<f64>) {
        let mut scored: Vec<(u32, f64, f64)> = Vec::new(); // (rid, upper, lower)
        let mut visit = |s: usize| {
            if self.passes(filter, s) {
                let (est, sd) = self.estimate(q, cq, s);
                scored.push((self.rids[s], est + eps * sd, est - eps * sd));
            }
        };
        match filter.allow {
            Some(allow) => {
                for rid in allow {
                    if let Some(&s) = self.slot_of.get(rid) {
                        visit(s as usize);
                    }
                }
            }
            None => (0..self.rids.len()).for_each(&mut visit),
        }
        if k == 0 || scored.is_empty() {
            return (Vec::new(), Vec::new());
        }
        let tau = if scored.len() <= k {
            f64::NEG_INFINITY
        } else {
            let mut lower: Vec<f64> = scored.iter().map(|x| x.2).collect();
            let (_, kth, _) = lower.select_nth_unstable_by(k - 1, |x, y| y.total_cmp(x));
            *kth
        };
        let mut kept: Vec<(u32, f64)> = scored.into_iter().filter(|x| x.1 >= tau).map(|x| (x.0, x.1)).collect();
        kept.sort_unstable_by(|x, y| y.1.total_cmp(&x.1).then(x.0.cmp(&y.0)));
        kept.into_iter().unzip()
    }
}

#[cfg(feature = "node")]
mod node {
    use super::{Filter, Index};
    use napi::bindgen_prelude::{Buffer, Float32Array, Float64Array, Uint32Array};
    use napi::{Error, Result};
    use napi_derive::napi;

    fn err(e: String) -> Error {
        Error::from_reason(e)
    }

    /// The candidates of one search: row ids, best upper bound first, and their upper bounds.
    #[napi(object)]
    pub struct Candidates {
        pub rids: Uint32Array,
        pub upper: Float64Array,
    }

    #[napi(js_name = "RabitqIndex")]
    pub struct RabitqIndex {
        inner: Index,
    }

    #[napi]
    impl RabitqIndex {
        #[napi(constructor, catch_unwind)]
        pub fn new(width: u32) -> Result<Self> {
            Ok(RabitqIndex { inner: Index::new(width as usize).map_err(err)? })
        }

        #[napi(getter, catch_unwind)]
        pub fn size(&self) -> u32 {
            self.inner.len() as u32
        }

        #[napi(catch_unwind)]
        pub fn heap_bytes(&self) -> f64 {
            self.inner.heap_bytes() as f64
        }

        #[napi(catch_unwind)]
        pub fn upsert(
            &mut self,
            rids: Uint32Array,
            nodes: Uint32Array,
            projects: Uint32Array,
            authors: Uint32Array,
            codes: Buffer,
            factors: Float32Array,
        ) -> Result<()> {
            self.inner.upsert(&rids, &nodes, &projects, &authors, &codes, &factors).map_err(err)
        }

        #[napi(catch_unwind)]
        pub fn remove(&mut self, rids: Uint32Array) {
            self.inner.remove(&rids);
        }

        #[napi(catch_unwind)]
        pub fn clear(&mut self) {
            self.inner.clear();
        }

        #[napi(catch_unwind)]
        #[allow(clippy::too_many_arguments)]
        pub fn search(
            &self,
            query: Float64Array,
            cq: f64,
            k: u32,
            eps: f64,
            node: u32,
            projects: Option<Uint32Array>,
            author: Option<u32>,
            allow: Option<Uint32Array>,
        ) -> Result<Candidates> {
            let q = self.inner.prepare(&query).map_err(err)?;
            let filter = Filter {
                node,
                projects: projects.as_deref(),
                author,
                allow: allow.as_deref(),
            };
            let (rids, upper) = self.inner.search(&q, cq, k as usize, eps, &filter);
            Ok(Candidates { rids: Uint32Array::new(rids), upper: Float64Array::new(upper) })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_zero_vector_is_never_held() {
        let mut ix = Index::new(64).unwrap();
        let code = [0xffu8; 8];
        ix.upsert(&[1, 2], &[0, 0], &[0, 0], &[0, 0], &[code, code].concat(), &[1.0, 1.0, 0.1, 0.0, 0.0, f32::INFINITY]).unwrap();
        assert_eq!(ix.len(), 1);
        ix.upsert(&[1], &[0], &[0], &[0], &code, &[0.0, 0.0, f32::INFINITY]).unwrap();
        assert_eq!(ix.len(), 0);
    }

    #[test]
    fn growth_zeroes_the_old_allocation() {
        let mut v: Vec<u64> = Vec::with_capacity(2);
        v.extend_from_slice(&[7, 9]);
        grow_zeroing(&mut v, 1);
        assert!(v.capacity() >= 3);
        assert_eq!(v, vec![7, 9]);
    }

    fn lcg(seed: &mut u64) -> f64 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 11) as f64) / ((1u64 << 53) as f64)
    }

    #[test]
    fn rejects_bad_widths() {
        assert!(Index::new(12).is_err());
        assert!(Index::new(4).is_err());
        assert!(Index::new(512).is_ok());
    }

    #[test]
    fn upsert_replace_and_remove_keep_slots_consistent() {
        let mut ix = Index::new(64).unwrap();
        let codes: Vec<u8> = (0..24).map(|i| i as u8).collect();
        ix.upsert(&[1, 2, 3], &[0, 0, 0], &[0, 0, 0], &[0, 0, 0], &codes, &[1.0; 9]).unwrap();
        assert_eq!(ix.len(), 3);
        ix.remove(&[1, 99]);
        assert_eq!(ix.len(), 2);
        assert_eq!(ix.slot_of.get(&3), Some(&0));
        ix.upsert(&[3], &[7], &[0], &[0], &[255; 8], &[1.0, 0.0, 0.0]).unwrap();
        assert_eq!(ix.len(), 2);
        assert_eq!(ix.nodes[0], 7);
        assert_eq!(ix.codes[0], u64::MAX);
        ix.clear();
        assert!(ix.is_empty());
    }

    #[test]
    fn rejects_mismatched_upserts() {
        let mut ix = Index::new(64).unwrap();
        assert!(ix.upsert(&[1], &[0], &[0], &[0], &[0; 7], &[0.0; 3]).is_err());
        assert!(ix.upsert(&[1], &[0, 0], &[0], &[0], &[0; 8], &[0.0; 3]).is_err());
    }

    #[test]
    fn filters_and_allowlist_limit_the_candidates() {
        let mut ix = Index::new(8).unwrap();
        ix.upsert(&[1, 2, 3], &[5, 5, 6], &[1, 2, 1], &[9, 9, 9], &[0, 0, 0], &[0.0, 1.0, 0.0].repeat(3))
            .unwrap();
        let q = ix.prepare(&[0.5, -0.5, 0.5, -0.5, 0.0, 0.0, 0.0, 0.0]).unwrap();
        let f = Filter { node: 5, projects: Some(&[2]), author: None, allow: None };
        assert_eq!(ix.search(&q, 0.0, 10, 1.9, &f).0, vec![2]);
        let f = Filter { node: 5, projects: None, author: Some(9), allow: Some(&[1, 3, 42]) };
        assert_eq!(ix.search(&q, 0.0, 10, 1.9, &f).0, vec![1]);
        let f = Filter { node: 6, projects: None, author: Some(8), allow: None };
        assert!(ix.search(&q, 0.0, 10, 1.9, &f).0.is_empty());
    }

    /// The candidate set always holds the exact top k when the bound holds: checked against a
    /// brute-force cosine over random vectors encoded as the TypeScript side encodes them.
    #[test]
    fn candidates_hold_the_exact_top_k() {
        let width = 64usize;
        let mut seed = 3u64;
        let mut ix = Index::new(width).unwrap();
        let n = 2000;
        let mut vecs = Vec::new();
        for rid in 0..n as u32 {
            let v: Vec<f64> = (0..width).map(|_| lcg(&mut seed) * 2.0 - 1.0).collect();
            let norm = v.iter().map(|x| x * x).sum::<f64>().sqrt();
            let l1: f64 = v.iter().map(|x| x.abs()).sum();
            let f = l1 / (width as f64).sqrt() / norm;
            let mut code = vec![0u8; width / 8];
            for (i, &x) in v.iter().enumerate() {
                if x > 0.0 {
                    code[i / 8] |= 1 << (i % 8);
                }
            }
            let a = (1.0 / f) as f32;
            let e = ((1.0 - f * f) / (f * f)).sqrt() / ((width - 1) as f64).sqrt();
            ix.upsert(&[rid], &[0], &[0], &[0], &code, &[a, (1.0 / norm) as f32, e as f32]).unwrap();
            vecs.push(v.iter().map(|x| x / norm).collect::<Vec<f64>>());
        }
        let mut missed = 0;
        for _ in 0..20 {
            let q: Vec<f64> = (0..width).map(|_| lcg(&mut seed) * 2.0 - 1.0).collect();
            let qn = q.iter().map(|x| x * x).sum::<f64>().sqrt();
            let q: Vec<f64> = q.iter().map(|x| x / qn).collect();
            let prepared = ix.prepare(&q).unwrap();
            let (cands, upper) = ix.search(&prepared, 0.0, 10, 3.0, &Filter { node: 0, projects: None, author: None, allow: None });
            assert!(upper.windows(2).all(|w| w[0] >= w[1]));
            let mut exact: Vec<(f64, u32)> =
                vecs.iter().enumerate().map(|(i, v)| (v.iter().zip(&q).map(|(x, y)| x * y).sum(), i as u32)).collect();
            exact.sort_by(|x, y| y.0.total_cmp(&x.0));
            for (_, rid) in &exact[..10] {
                if !cands.contains(rid) {
                    missed += 1;
                }
            }
        }
        assert_eq!(missed, 0);
    }
}
