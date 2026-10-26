/*
 * Cases ported from ini 7.0.0's test suite (test/foo.js, bar.js,
 * duplicate-properties.js, proto.js, win32.js), adapted to parseNpmrc.
 * https://github.com/npm/ini/tree/v7.0.0/test
 *
 * The ISC License
 *
 * Copyright (c) Isaac Z. Schlueter and Contributors
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
 * IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
import { parseNpmrc, substituteEnv } from '@/utils/npmrc'

const parse = (text: string, env: NodeJS.ProcessEnv = {}) => ({
  ...parseNpmrc(text, env),
})

describe('parseNpmrc (ini 7 decode)', () => {
  it('trims keys and values and keeps inner spaces', () => {
    expect(parse('o = p\n\n   a with spaces   =     b  c\n')).toEqual({
      o: 'p',
      'a with spaces': 'b  c',
    })
  })

  it('JSON-decodes a double-quoted key and value', () => {
    expect(parse('" xa  n          p " = "\\"\\r\\nyoyoyo\\r\\r\\n"')).toEqual({
      ' xa  n          p ': '"\r\nyoyoyo\r\r\n',
    })
  })

  it('treats a quoted bracket key as a key, not a section', () => {
    expect(parse('"[disturbing]" = hey you never know')).toEqual({
      '[disturbing]': 'hey you never know',
    })
  })

  it('strips single quotes and keeps what is inside', () => {
    expect(parse("s = 'something'\ns5 = '   '\ns6 = ' a '")).toEqual({
      s: 'something',
      s5: '   ',
      s6: ' a ',
    })
  })

  it('keeps single-quoted numbers as strings', () => {
    expect(parse("n = '123'")).toEqual({ n: '123' })
  })

  it('keeps mismatched quotes as written', () => {
    expect(parse(`s1 = "something'`)).toEqual({ s1: `"something'` })
  })

  it('keeps a double-quoted value that is not valid JSON as written', () => {
    expect(parse('j = "{ o: "p" }"')).toEqual({ j: '"{ o: "p" }"' })
  })

  it('decodes a double-quoted value', () => {
    expect(parse('s2 = "something else"')).toEqual({ s2: 'something else' })
  })

  it('reads blank and whitespace-only values as empty strings', () => {
    expect(parse('s3 =\ns4 =        ')).toEqual({ s3: '', s4: '' })
  })

  it('reads a key without an equals sign as true', () => {
    expect(parse('s7')).toEqual({ s7: true })
  })

  it('reads true, false and null as those values', () => {
    expect(
      parse('true = true\nfalse = false\nnull = null\nundefined = undefined'),
    ).toEqual({
      true: true,
      false: false,
      null: null,
      undefined: 'undefined',
    })
  })

  it('keeps an equals sign inside a value', () => {
    expect(parse('eq = "eq=eq"\nplain = a=b=c')).toEqual({
      eq: 'eq=eq',
      plain: 'a=b=c',
    })
  })

  it('skips comment lines starting with ; or #', () => {
    expect(parse('; a comment\n# another\n  ; indented\nk = v')).toEqual({
      k: 'v',
    })
  })

  it('cuts an unquoted value at the first unescaped ; or #', () => {
    expect(parse('a = x ; y\nb = x # y\nc = x  # y')).toEqual({
      a: 'x',
      b: 'x',
      c: 'x',
    })
  })

  it('keeps escaped ; and # and unescapes \\\\', () => {
    expect(
      parse(
        'nocomment = this\\; this is not a comment\nnoHash = this\\# this is not a comment\nback = a\\\\b',
      ),
    ).toEqual({
      nocomment: 'this; this is not a comment',
      noHash: 'this# this is not a comment',
      back: 'a\\b',
    })
  })

  it('keeps any other escape as written, and a trailing backslash', () => {
    expect(parse('p = C:\\temp\\n\nq = x "\\')).toEqual({
      p: 'C:\\temp\\n',
      q: 'x "\\',
    })
  })

  it('reads CRLF line endings', () => {
    expect(parse('a = 1\r\nb = 2\r\n')).toEqual({ a: '1', b: '2' })
  })

  it('skips a line with no key', () => {
    expect(parse('=just junk!\nk = v')).toEqual({ k: 'v' })
  })

  it('lets a repeated key replace the earlier value', () => {
    expect(parse('br = cold\nbr = warm')).toEqual({ br: 'warm' })
    expect(parse('brr = 1\nbrr = 2\nbrr = 3\nbrr = 3')).toEqual({ brr: '3' })
  })

  describe('arrays', () => {
    it('collects key[] lines', () => {
      expect(parse('zr[] = deedee\nar[] = one\nar[] = three')).toEqual({
        zr: ['deedee'],
        ar: ['one', 'three'],
      })
    })

    it('appends a plain key repeated after an array key', () => {
      expect(
        parse('ar[] = one\nar[] = three\nar   = this is included'),
      ).toEqual({
        ar: ['one', 'three', 'this is included'],
      })
      expect(parse('zr[] = deedee\nzr=123')).toEqual({ zr: ['deedee', '123'] })
    })

    it('turns an earlier plain key into the first element', () => {
      expect(parse('y=1\ny[]=2\r\n')).toEqual({ y: ['1', '2'] })
    })

    it('reads values of array elements as scalars', () => {
      expect(parse('x[] = true\nx[] = null')).toEqual({ x: [true, null] })
    })

    it('keeps a bare [] as a plain key', () => {
      expect(parse('"[]" = a square?')).toEqual({ '[]': 'a square?' })
    })
  })

  describe('sections', () => {
    it('stops parsing at the first [section]', () => {
      expect(parse('a = 1\n[a]\nb = 2\n[b] \nc = 3')).toEqual({ a: '1' })
    })

    it('stops at a section even without earlier keys', () => {
      expect(parse('[x]\nk = v')).toEqual({})
    })
  })

  describe('prototype safety', () => {
    it('skips __proto__ and builds a null-prototype object', () => {
      const data = [
        '__proto__ = quux',
        'constructor.prototype.foo = asdfasdf',
        'foo = baz',
        'arrproto[] = x',
        '__proto__[] = you did a good job',
        '__proto__[] = so you deserve arrays',
        'thanks = true',
      ].join('\n')
      const result = parseNpmrc(data, {})

      expect(Object.getPrototypeOf(result)).toBeNull()
      expect({ ...result }).toEqual({
        'constructor.prototype.foo': 'asdfasdf',
        foo: 'baz',
        arrproto: ['x'],
        thanks: true,
      })
      expect((result as { __proto__?: unknown }).__proto__).toBeUndefined()
      expect(({} as Record<string, unknown>).foo).toBeUndefined()
      expect(([] as unknown as Record<string, unknown>)[0]).toBeUndefined()
      expect(([] as unknown as Record<string, unknown>)[1]).toBeUndefined()
    })
  })

  it('reads a realistic .npmrc', () => {
    const text = [
      '; npm config',
      'registry=https://registry.example.com/',
      '@corp:registry=https://npm.corp.example/',
      '//registry.example.com/:_authToken=abc123',
      '//npm.corp.example:8080/:_auth=dTpw',
      'ca[]="-----BEGIN CERTIFICATE-----\\nAAA\\n-----END CERTIFICATE-----"',
      'strict-ssl=false',
    ].join('\n')

    expect(parse(text)).toEqual({
      registry: 'https://registry.example.com/',
      '@corp:registry': 'https://npm.corp.example/',
      '//registry.example.com/:_authToken': 'abc123',
      '//npm.corp.example:8080/:_auth': 'dTpw',
      ca: ['-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----'],
      'strict-ssl': false,
    })
  })
})

describe('environment substitution', () => {
  const env = { TOKEN: 'secret', EMPTY: '' }

  it('replaces ${VAR} in values', () => {
    expect(parse('//r.example/:_authToken=${TOKEN}', env)).toEqual({
      '//r.example/:_authToken': 'secret',
    })
  })

  it('replaces ${VAR} in keys', () => {
    expect(parse('//${TOKEN}.example/:_authToken=x', env)).toEqual({
      '//secret.example/:_authToken': 'x',
    })
  })

  it('replaces ${VAR} in each array element', () => {
    expect(parse('ca[]=${TOKEN}\nca[]=a-${TOKEN}-b', env)).toEqual({
      ca: ['secret', 'a-secret-b'],
    })
  })

  it('replaces a set but empty variable with an empty string', () => {
    expect(parse('k=${EMPTY}', env)).toEqual({ k: '' })
  })

  it('keeps an unset ${VAR} literal', () => {
    expect(parse('k=${MISSING}', env)).toEqual({ k: '${MISSING}' })
  })

  it('turns an unset ${VAR?} into an empty string', () => {
    expect(parse('k=${MISSING?}', env)).toEqual({ k: '' })
  })

  it('leaves an escaped \\${VAR} as the literal reference', () => {
    expect(parse('k=\\${TOKEN}', env)).toEqual({ k: '${TOKEN}' })
  })

  it('consumes half of an even run of backslashes and substitutes', () => {
    // Unquoting turns `\\` into `\` first, then the reference is replaced.
    expect(parse('k=\\\\\\\\${TOKEN}', env)).toEqual({ k: '\\secret' })
    expect(substituteEnv('\\\\\\\\${TOKEN}', env)).toBe('\\\\secret')
    expect(substituteEnv('\\\\\\${TOKEN}', env)).toBe('\\${TOKEN}')
  })

  it('substitutes after the true/false/null check', () => {
    expect(parse('k=${FLAG}', { FLAG: 'true' })).toEqual({ k: 'true' })
  })

  it('substituteEnv works on plain text', () => {
    expect(substituteEnv('a ${TOKEN} b ${MISSING}', env)).toBe(
      'a secret b ${MISSING}',
    )
  })
})
