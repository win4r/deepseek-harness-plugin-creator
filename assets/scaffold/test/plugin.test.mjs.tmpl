import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Config, MODES, apply, normalizeConfig, transformText } from '../dist/index.js'

test('exports a Standard Schema with closed runtime normalization', () => {
  assert.equal(Config['~standard'].version, 1)
  assert.deepEqual(normalizeConfig({}), { defaultMode: 'upper', maxLength: 10_000 })
  assert.throws(() => normalizeConfig({ unexpected: true }), /unknown config key/)
  assert.throws(() => normalizeConfig({ maxLength: 0 }))
})

test('pure transformation covers every declared mode', () => {
  assert.deepEqual([...MODES], ['upper', 'lower', 'title'])
  assert.equal(transformText('Hello', 'upper'), 'HELLO')
  assert.equal(transformText('Hello', 'lower'), 'hello')
  assert.equal(transformText('hello world', 'title'), 'Hello World')
})

test('tool reports truncation to both structured output and rendered content', async () => {
  let definition
  apply({
    tools: {
      register(value) {
        definition = value
        return () => {}
      },
    },
  }, { defaultMode: 'upper', maxLength: 3 })

  assert.ok(definition)
  const execution = { signal: new AbortController().signal }
  const result = await definition.execute({ text: 'abcdef' }, execution)
  assert.deepEqual(result, {
    text: 'ABC',
    mode: 'upper',
    originalLength: 6,
    processedLength: 3,
    truncated: true,
  })
  const rendered = definition.output.render({}, result)
  assert.match(rendered[0].text, /TRUNCATED: processed 3 of 6/)
  await assert.rejects(() => definition.execute({ text: 'x', extra: true }, execution), /unknown tool argument/)
})

test('tool truncates and counts by Unicode code point without splitting emoji', async () => {
  let definition
  apply({ tools: { register(value) { definition = value; return () => {} } } }, {
    defaultMode: 'upper',
    maxLength: 2,
  })
  const result = await definition.execute(
    { text: 'a😀b' },
    { signal: new AbortController().signal },
  )
  assert.deepEqual(result, {
    text: 'A😀',
    mode: 'upper',
    originalLength: 3,
    processedLength: 2,
    truncated: true,
  })
  assert.equal([...result.text].length, 2)
})

test('tool honors an already-aborted execution', async () => {
  let definition
  apply({ tools: { register(value) { definition = value; return () => {} } } }, {})
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => definition.execute({ text: 'hello' }, { signal: controller.signal }),
    /aborted before start/,
  )
})
