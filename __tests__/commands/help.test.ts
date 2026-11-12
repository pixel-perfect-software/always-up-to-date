import type { CommanderError } from 'commander'
import { program } from '@/cli'

/** Run the real program with `args`, capturing what commander prints. */
const run = async (
  args: string[],
): Promise<{ out: string; err: string; code: number }> => {
  let out = ''
  let err = ''
  for (const cmd of [program, ...program.commands]) {
    cmd.exitOverride()
    cmd.configureOutput({
      writeOut: (s) => {
        out += s
      },
      writeErr: (s) => {
        err += s
      },
    })
  }
  try {
    await program.parseAsync(['node', 'autd', ...args])
    return { out, err, code: 0 }
  } catch (error) {
    return { out, err, code: (error as CommanderError).exitCode }
  }
}

describe('help', () => {
  it('names the program autd', async () => {
    const { out, code } = await run(['--help'])
    expect(code).toBe(0)
    expect(out).toContain('Usage: autd ')
    expect(out).not.toContain('@pixel-perfect-software')
  })

  it('prints a command help with `help <command>`', async () => {
    const { out, err, code } = await run(['help', 'update'])
    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toContain('Usage: autd update')
    expect(out).toContain('--dry-run')
  })

  it('lists the commands with `help`', async () => {
    const { out, code } = await run(['help'])
    expect(code).toBe(0)
    for (const name of ['check', 'update', 'init']) {
      expect(out).toContain(name)
    }
  })

  it('names npm, pnpm, yarn and bun in the program description', () => {
    for (const manager of ['npm', 'pnpm', 'yarn', 'bun']) {
      expect(program.description()).toContain(manager)
    }
  })

  it.each(['check', 'update', 'init'])('describes %s', (name) => {
    const cmd = program.commands.find((c) => c.name() === name)
    expect(cmd?.description()).not.toBe('')
    expect(cmd?.description()).not.toMatch(/update-able|basic setup/)
  })
})
