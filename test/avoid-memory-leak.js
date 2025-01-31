#!/usr/bin/env node --expose-gc

// https://github.com/isaacs/node-lru-cache/issues/227

const t = require('tap')

const maxSize = 100_000
const itemSize = 1_000
const profEvery = 10_000
const n = 1_000_000

if (typeof gc !== 'function') {
  t.plan(0, 'run with --expose-gc')
  process.exit(0)
}

const tryReq = mod => {
  try {
    return require(mod)
  } catch (er) {
    t.plan(0, `need ${mod} module`)
    process.exit(0)
  }
}

const v8 = tryReq('v8')

const LRUCache = require('../')
const expectItemCount = Math.ceil(maxSize / itemSize)
const max = expectItemCount + 1
const keyRange = expectItemCount * 2

// fine to alloc unsafe, we don't ever look at the data
const makeItem = () => Buffer.allocUnsafe(itemSize)

let cache = new LRUCache({ maxSize, sizeCalculation: s => s.length })

const prof = (i, cache) => {
  // run gc so that we know if we're actually leaking memory, or just
  // that the gc is being lazy and not responding until there's memory
  // pressure.
  gc()
  return {
    i,
    ...v8.getHeapStatistics(),
    valListLength: cache.valList.length,
    freeLength: cache.free.length,
  }
}

const runTest = async (t, cache) => {
  // first, fill to expected size
  for (let i = 0; i < expectItemCount; i++) {
    cache.set(i, makeItem())
  }

  // now start the setting and profiling
  const profiles = []
  for (let i = 0; i < n; i++) {
    if ((i % profEvery) === 0) {
      const profile = prof(i, cache)
      t.ok(
        profile.valListLength <= max,
        `expect valList to have fewer than ${max} items`,
        { found: profile.valListLength },
      )
      t.ok(
        profile.freeLength <= 1,
        'expect free stack to have <= 1 item',
        { found: profile.freeLength },
      )
      t.equal(profile.number_of_native_contexts, 1, '1 native context')
      t.equal(profile.number_of_detached_contexts, 0, '0 native context')
      profiles.push(profile)
    }

    const item = makeItem()
    cache.set(i % keyRange, item)
  }

  const profile = prof(n, cache)
  profiles.push(profile)

  // Warning: kludgey inexact test!
  // memory leaks can be hard to catch deterministically.
  // The first few items will tend to be lower, and we'll see
  // *some* modest increase in heap usage from tap itself as it
  // runs the test and builds up its internal results data.
  // But, after the initial few profiles, it should be modest.
  // Considering that the reported bug showed a 10x increase in
  // memory in this reproduction case, 2x is still pretty aggressive,
  // without risking false hits from other node or tap stuff.

  const start = Math.floor(profiles.length / 2)
  const initial = profiles[start]
  for (let i = start; i < profiles.length; i++) {
    const current = profiles[i]
    const delta = current.total_heap_size / initial.total_heap_size
    t.ok(delta < 2, 'memory growth should not be unbounded', {
      delta,
      current,
      initial,
    })
  }
}

t.test('both max and maxSize', t =>
  runTest(t, new LRUCache({
    maxSize,
    sizeCalculation: s => s.length,
    max,
  })))

t.test('no max, only maxSize', t =>
  runTest(t, new LRUCache({
    maxSize,
    sizeCalculation: s => s.length,
  })))

t.test('only max, no maxSize', t =>
  runTest(t, new LRUCache({ max })))
