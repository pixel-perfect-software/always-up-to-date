/**
 * Runs at most `max` tasks at once, the rest first in, first out. A task that
 * throws frees its slot.
 */
export const createLimiter = (max: number) => {
  let active = 0
  const waiting: Array<() => void> = []
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) active++
    // The slot is handed over by the task that finishes, so `active` stays.
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}
