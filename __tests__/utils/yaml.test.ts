import { parseYaml } from '@/utils/yaml'

// The reader berry's files and pnpm's share. Berry's own cases (block maps,
// sequences of maps, escapes, what it leaves out) are in yarnrcYml.test.ts.
describe('parseYaml', () => {
  it('ends a plain key at the first colon followed by a space or the end, so a URL key keeps its colons', () => {
    expect(
      parseYaml(
        [
          'http://h:4873/:',
          '  scopes: ["@a"]',
          'http://h:${PORT}/: x',
          'a: b: c',
          'time: 12:30',
          '"quoted" : spaced',
        ].join('\n'),
      ),
    ).toEqual({
      'http://h:4873/': { scopes: ['@a'] },
      'http://h:${PORT}/': 'x',
      a: 'b: c',
      time: '12:30',
      quoted: 'spaced',
    })
  })

  it('keeps a scalar holding colons a sequence item, not a key', () => {
    expect(parseYaml('a:\n  - http://x/\n  - a:b\n')).toEqual({
      a: ['http://x/', 'a:b'],
    })
  })

  it('reads a range starting with > as text, and a block scalar header as a block scalar', () => {
    expect(
      parseYaml('a: >=18.0.0 <19\nb: >\n  folded\nc: |-\n  kept\nd: ok\n'),
    ).toEqual({ a: '>=18.0.0 <19', d: 'ok' })
  })

  it('splits a flow sequence at its own commas only', () => {
    expect(parseYaml('a: ["x, y", z]\nb: [x, [y, z]]\n')).toEqual({
      a: ['x, y', 'z'],
    })
  })

  it('takes a tab in a blank or comment line, and empties the file for one before content', () => {
    expect(parseYaml('a: 1\n\t\n\t# comment\nb: 2\n')).toEqual({
      a: '1',
      b: '2',
    })
    expect(parseYaml('a:\n\tb: 1\nc: 2\n')).toEqual({})
  })

  describe('flowMaps', () => {
    const flat = 'r: { default: http://a/, "@acme": \'http://b/\' } # c\n'

    it('leaves a flow map out without the option, as berry reads it', () => {
      expect(parseYaml(`${flat}k: v\n`)).toEqual({ k: 'v' })
    })

    it('reads a flat one-line flow map with the option', () => {
      expect(parseYaml(flat, { flowMaps: true })).toEqual({
        r: { default: 'http://a/', '@acme': 'http://b/' },
      })
    })

    it('reads flow sequences inside it and an empty one', () => {
      expect(
        parseYaml('r: { scopes: ["@a", "@b"], ecosystem: npm }\ne: {}\n', {
          flowMaps: true,
        }),
      ).toEqual({ r: { scopes: ['@a', '@b'], ecosystem: 'npm' }, e: {} })
    })

    it('leaves out a flow map that nests another, or spans lines', () => {
      expect(
        parseYaml(
          'r: { http://a/: { scopes: ["@a"] } }\nm: {\n  a: b\n}\nk: v\n',
          { flowMaps: true },
        ),
      ).toEqual({ k: 'v' })
    })

    it('reads a flow map as a block entry value', () => {
      expect(
        parseYaml('r:\n  http://a/: { scopes: ["@a"] }\n', { flowMaps: true }),
      ).toEqual({ r: { 'http://a/': { scopes: ['@a'] } } })
    })
  })

  describe('anchors', () => {
    const anchored = 'c: &c\n  ms: ^2\np: &p "~"\nalias: *c\nk: v\n'

    it('leaves an anchored value out without the option, as berry reads it', () => {
      expect(parseYaml(anchored)).toEqual({ k: 'v' })
    })

    it('reads the anchored node with the option; an alias is still left out', () => {
      expect(parseYaml(anchored, { anchors: true })).toEqual({
        c: { ms: '^2' },
        p: '~',
        k: 'v',
      })
    })
  })
})
