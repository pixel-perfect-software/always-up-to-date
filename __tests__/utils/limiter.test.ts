import { createLimiter } from '@/utils/limiter'

const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createLimiter', () => {
  it('never runs more than max tasks at once', async () => {
    const limit = createLimiter(3)
    let active = 0
    let peak = 0
    const task = async () => {
      peak = Math.max(peak, ++active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active--
    }

    await Promise.all(Array.from({ length: 12 }, () => limit(task)))

    expect(peak).toBe(3)
  })

  it('starts waiting tasks in the order they were queued', async () => {
    const limit = createLimiter(1)
    const first = deferred()
    const started: number[] = []
    const run = (n: number, gate?: Promise<void>) =>
      limit(async () => {
        started.push(n)
        await gate
      })

    const all = [run(1, first.promise), run(2), run(3), run(4)]
    expect(started).toEqual([1])
    first.resolve()
    await Promise.all(all)

    expect(started).toEqual([1, 2, 3, 4])
  })

  it('frees the slot of a task that rejects', async () => {
    const limit = createLimiter(1)

    const failed = limit(async () => {
      throw new Error('boom')
    })
    const next = limit(async () => 'after')

    await expect(failed).rejects.toThrow('boom')
    await expect(next).resolves.toBe('after')
    await expect(limit(async () => 'idle')).resolves.toBe('idle')
  })

  it('returns what the task returns', async () => {
    const limit = createLimiter(2)

    await expect(limit(async () => 42)).resolves.toBe(42)
  })
})
