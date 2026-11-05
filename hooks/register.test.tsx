import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { forProvider, routerRequest, shortenOldResults, streamReader, summarizeTools, toolNameFor, trimText } from './register'

type RunAnswer = { value: { exitCode: number; stdout: string; stderr: string } }
// The mod streams curl through `process.spawn`: answer it as `process.run` was.
const viaSpawn = (
  on: Parameters<TestBody>[1],
  answer: (_: unknown, e: { argv: readonly string[]; init?: { stdin?: string; timeoutMs?: number } }) => RunAnswer,
) =>
  on('process.spawn', async function* (_, e) {
    const out = answer(undefined, { argv: e.argv, init: { stdin: e.input, timeoutMs: 600000 } }).value
    if (out.stdout) {
      yield { stream: 'stdout' as const, text: out.stdout }
    }
    if (out.stderr) {
      yield { stream: 'stderr' as const, text: out.stderr }
    }

    return { value: { code: out.exitCode, signal: null } }
  })

const BAND = {
  plugin: 'provedores',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

test('signed thinking is left out of what the provider receives', () => {
  const { messages: out } = forProvider([
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] },
    { role: 'user', content: [{ type: 'text', text: 'oi' }] },
  ])

  expect(out).toEqual([{ role: 'user', content: [{ type: 'text', text: 'oi' }] }])
})

test('the switch starts on Claude and turns to 9router', async $ => {
  for (const surface of ['desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const before = await ui.find({ key: 'chave' })
    expect(JSON.stringify(before)).toContain('● Claude')
    await ui.unmount()
  }
})

test('a step goes to Claude while the switch is off', async ($, on) => {
  let sent = 0
  on('turn.step', async function* () {
    sent += 1
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }

    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  let fetched = 0
  on('http.fetch', () => {
    fetched += 1

    return { value: { status: 500, ok: false, headers: {}, text: '' } }
  })

  const stream = $.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 1 })
  for await (const chunk of stream) {
    void chunk
  }

  expect(sent).toBe(1)
  expect(fetched).toBe(0)
})

test('with the switch on and a key stored, the step goes to 9router and comes back as chunks', async ($, on) => {
  mock.store(on, { 'url-9router': 'https://router.example/v1', 'chave-9router': 'chave-de-teste' })
  on('command.register', () => ({ value: { command: 'provedor' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.list', () => ({
    value: [
      { name: 'Read', description: 'Read a file', mcp: false },
      { name: 'Bash', description: 'Run a command', mcp: false },
    ],
  }))
  on('ui.status', () => ({ value: undefined }))
  on('prompt.section', (_, e) => ({ text: e.text }))
  on('session.messages', () => ({
    value: [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] },
      { role: 'user', content: [{ type: 'text', text: 'oi' }] },
    ],
  }))
  on('turn.step', async function* () {
    throw new Error('Claude must not be asked while the switch is on')
  })

  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{"data":[]}' } }))
  // The step goes through curl, whose config comes in on stdin.
  const sent: { argv: readonly string[]; stdin?: string; timeoutMs?: number }[] = []
  viaSpawn(on, (_, e) => {
    sent.push({ argv: e.argv, stdin: e.init?.stdin, timeoutMs: e.init?.timeoutMs })

    return {
      value: {
        exitCode: 0,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
        stdout:
          JSON.stringify({
            content: [
              { type: 'text', text: 'Vou ler.' },
              { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.md' } },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 5 },
          }) + '\n@@HTTP 200',
      },
    }
  })

  await $.prompt.section({ name: 'intro', text: 'sistema do Claude' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'chave' })

  const stream = $.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 2 })
  const chunks = []
  let step = await stream.next()
  while (!step.done) {
    chunks.push(step.value)
    step = await stream.next()
  }
  const result = step.value
  await ui.unmount()

  const call = sent[0]
  expect(call?.argv.join(' ')).not.toContain('chave-de-teste')
  expect(call?.stdin).toContain('request = "POST"')
  expect(call?.stdin).toContain('authorization: Bearer chave-de-teste')
  expect(call?.stdin).not.toContain('thinking')
  expect(call?.stdin).toContain('sistema do Claude')
  expect(call?.timeoutMs).toBeGreaterThan(30000)
  expect(chunks).toEqual([
    { kind: 'text', index: 0, text: 'Vou ler.' },
    { kind: 'tool', index: 1, id: 'toolu_1', name: 'Read' },
    { kind: 'input', index: 1, json: '{"file_path":"/a.md"}' },
    {
      kind: 'stop',
      stopReason: 'tool_use',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        model: 'gpt-6.1-sol',
      },
    },
  ])
  expect(result.answer).toBe('Vou ler.')
  expect(result.stopReason).toBe('tool_use')
  expect(result.toolUses).toEqual([{ name: 'Read', input: { file_path: '/a.md' } }])
})

test('an answer in OpenAI shape (choices, tool_calls) is read too', async ($, on) => {
  mock.store(on, { 'url-9router': 'https://router.example/v1', 'chave-9router': 'chave-de-teste' })
  on('command.register', () => ({ value: { command: 'provedor' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.list', () => ({ value: [{ name: 'Read', description: 'Read a file', mcp: false }] }))
  on('ui.status', () => ({ value: undefined }))
  on('prompt.section', (_, e) => ({ text: e.text }))
  on('session.messages', () => ({ value: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }] }))
  on('turn.step', async function* () {
    throw new Error('Claude must not be asked while the switch is on')
  })
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{"data":[]}' } }))
  viaSpawn(on, () => ({
    value: {
      exitCode: 0,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
      stdout:
        JSON.stringify({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: 'Vou ler.',
                tool_calls: [
                  { id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/a.md"}' } },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }) + '\n@@HTTP 200',
    },
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'chave' })

  const stream = $.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 1 })
  let step = await stream.next()
  while (!step.done) {
    step = await stream.next()
  }
  const result = step.value
  await ui.unmount()

  expect(result.answer).toBe('Vou ler.')
  expect(result.stopReason).toBe('tool_use')
  expect(result.toolUses).toEqual([{ name: 'Read', input: { file_path: '/a.md' } }])
})

const routed = (on: Parameters<TestBody>[1], store: Record<string, string>) => {
  mock.store(on, { 'url-9router': 'https://router.example/v1', ...store })
  on('command.register', () => ({ value: { command: 'provedor' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.list', () => ({ value: [{ name: 'Read', description: 'Read a file', mcp: false }] }))
  on('ui.status', () => ({ value: undefined }))
  on('session.messages', () => ({ value: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }] }))
  on('turn.step', async function* () {
    throw new Error('Claude must not be asked while the switch is on')
  })
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{"data":[{"id":"modelo-a","owned_by":"combo"},{"id":"modelo-b","owned_by":"combo"}]}' } }))
  on('clock.sleep', () => ({ value: undefined }))
}
const curl = (stdout: string, exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})
const OK = JSON.stringify({ content: [{ type: 'text', text: 'pronto' }], stop_reason: 'end_turn' }) + '\n@@HTTP 200'

test('the key typed in the band is what the next step sends, and a picked model goes with it', async ($, on) => {
  routed(on, {})
  const sent: (string | undefined)[] = []
  viaSpawn(on, (_, e) => {
    sent.push(e.init?.stdin)

    return curl(OK)
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'chave' })
  await ui.input({ key: 'chave-api', text: '  chave-digitada  ' })
  for (let tick = 0; tick < 50; tick += 1) {
    await Promise.resolve()
  }
  await ui.select({ key: 'modelo', value: 'modelo-b' })

  const stream = $.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 1 })
  let step = await stream.next()
  while (!step.done) {
    step = await stream.next()
  }
  await ui.unmount()

  expect(step.value.answer).toBe('pronto')
  expect(sent[0]).toContain('authorization: Bearer chave-digitada"')
  expect(sent[0]).toContain('modelo-b')
})

for (const [name, answer, wanted] of [
  ['an HTTP error', curl('{"error":"sem credito"}\n@@HTTP 402'), 'respondeu 402'],
  ['curl failing', curl('', 28, 'timed out'), 'curl 28: timed out'],
  ['an answer that is not JSON', curl('<html>\n@@HTTP 200'), 'respondeu sem texto'],
  ['an answer with no text', curl('{"choices":[{"message":{"reasoning_content":"x"}}]}\n@@HTTP 200'), 'respondeu sem texto'],
] as const) {
  test(`${name} ends the turn with a message, never in silence`, async ($, on) => {
    routed(on, { 'chave-9router': 'k' })
    viaSpawn(on, () => answer)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    await ui.press({ key: 'chave' })
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 1 })
    let step = await stream.next()
    while (!step.done) {
      step = await stream.next()
    }
    await ui.unmount()

    expect(step.value.answer).toContain(wanted)
    expect(step.value.stopReason).toBe('end_turn')
  })
}

test('the phone draws the switch and the models as buttons that work', async ($, on) => {
  routed(on, { 'chave-9router': 'k' })
  const sent: (string | undefined)[] = []
  viaSpawn(on, (_, e) => {
    sent.push(e.init?.stdin)

    return curl(OK)
  })
  await $.session.start({ cwd: '/', surface: 'mobile', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'mobile' })
  await ui.press({ key: 'chave' })
  await ui.press({ key: 'modelo-modelo-b' })
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 1 })
  let step = await stream.next()
  while (!step.done) {
    step = await stream.next()
  }
  await ui.unmount()

  expect(sent[0]).toContain('modelo-b')
})
const routedAgent = (
  on: Parameters<TestBody>[1],
  store: Record<string, string>,
  agents: { id: string; type: string }[],
  tools = [{ name: 'Read', description: 'r', mcp: false }],
) => {
  mock.store(on, { 'url-9router': 'https://router.example/v1', ...store })
  const registered: string[] = []
  on('command.register', () => ({ value: { command: 'provedor' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.register', (_, e) => {
    registered.push(e.name)

    return { value: { agent: `provedores:${e.name}` } }
  })
  on('agent.list', () => ({
    value: agents.map(one => ({ ...one, description: 'x', status: 'running' as const })),
  }))
  on('session.cwd', () => ({ value: '/projeto' }))
  on('tool.list', () => ({ value: tools }))
  on('http.fetch', () => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({ data: [{ id: 'gpt-6.1-sol', owned_by: 'combo' }, { id: 'Antygravit', owned_by: 'combo' }, { id: 'cx/gpt-6.1-sol', owned_by: 'cx' }] }),
    },
  }))

  return registered
}

const REPLY = {
  exitCode: 0,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
  stdout: JSON.stringify({ content: [{ type: 'text', text: 'feito' }], stop_reason: 'end_turn' }) + '\n@@HTTP 200',
}

test('only the combos become subagent types, with the short names too', async ($, on) => {
  const registered = routedAgent(on, { 'chave-9router': 'k' }, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect([...registered].sort()).toEqual(['Antygravit', 'antigravity', 'gpt-6_1-sol', 'sol'].sort())
})

test('without a key no subagent type is registered', async ($, on) => {
  const registered = routedAgent(on, {}, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect(registered).toEqual([])
})

test('a 9router subagent goes to its own model with its own conversation, switch off', async ($, on) => {
  routedAgent(on, { 'chave-9router': 'k' }, [{ id: 'a1', type: 'provedores:sol' }])
  on('turn.step', async function* () {
    throw new Error('Claude must not be asked for this subagent')
  })
  const asked: unknown[] = []
  on('session.messages', (_, e) => {
    asked.push(e)

    return { value: [{ role: 'user', content: [{ type: 'text', text: 'tarefa do subagente' }] }] }
  })
  const sent: (string | undefined)[] = []
  viaSpawn(on, (_, e) => {
    sent.push(e.init?.stdin)

    return { value: REPLY }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 1, agentId: 'a1' })
  let step = await stream.next()
  while (!step.done) {
    step = await stream.next()
  }

  expect(step.value.answer).toBe('feito')
  expect(JSON.stringify(asked)).toContain('a1')
  expect(sent[0]).toContain('gpt-6.1-sol')
  expect(sent[0]).toContain('tarefa do subagente')
  expect(sent[0]).toContain('/projeto')
})

test('any other subagent stays on the session model, even with the switch on', async ($, on) => {
  routedAgent(on, { 'chave-9router': 'k' }, [{ id: 'a2', type: 'Explore' }])
  let claude = 0
  on('turn.step', async function* () {
    claude += 1
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }

    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  let curl = 0
  viaSpawn(on, () => {
    curl += 1

    return { value: REPLY }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'chave' })
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 1, agentId: 'a2' })
  for await (const chunk of stream) {
    void chunk
  }
  await ui.unmount()

  expect(claude).toBe(1)
  expect(curl).toBe(0)
})
test('a tool ToolSearch loaded goes with its real schema, and only then', async ($, on) => {
  routedAgent(on, { 'chave-9router': 'k' }, [{ id: 'a1', type: 'provedores:sol' }], [
      { name: 'Read', description: 'r', mcp: false },
      { name: 'ToolSearch', description: 's', mcp: false },
      { name: 'mcp__loja__buscar', description: 'curta', mcp: true },
      { name: 'mcp__loja__novo', description: 'sem esquema', mcp: true },
    ])
  on('fs.read', () => ({
    value: JSON.stringify({
      mcp__loja__buscar: { description: 'Busca na loja', input_schema: { type: 'object', properties: { nome: { type: 'string' } } } },
    }),
  }))
  on('session.messages', () => ({
    value: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'x', content: [{ type: 'tool_reference', tool_name: 'mcp__loja__buscar' }] },
        ],
      },
    ],
  }))
  on('tool.call', { tool: 'ToolSearch' }, () => ({
    result: { matches: ['mcp__loja__buscar', 'mcp__loja__novo'] },
    text: '',
  }))
  const sent: string[] = []
  viaSpawn(on, (_, e) => {
    sent.push(e.init?.stdin ?? '')

    return { value: REPLY }
  })
  const step = async () => {
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 1, agentId: 'a1' })
    for await (const chunk of stream) {
      void chunk
    }
  }

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await step()
  expect(sent[0]).toContain('ToolSearch')
  expect(sent[0]).not.toContain('Busca na loja')

  await $.tool.call({ tool: 'ToolSearch', query: 'select:mcp__loja__buscar', max_results: 2, agentId: 'a1' } as never)
  await step()
  expect(sent[1]).toContain('Busca na loja')
  expect(sent[1]).toContain('mcp__loja__novo')
  expect(sent[1]).toContain('additionalProperties')
  expect(sent[1]).not.toContain('tool_reference')
  expect(sent[1]).toContain('Ferramenta carregada: mcp__loja__buscar')
})
const sse = (...events: object[]) => events.map(one => `event: x\ndata: ${JSON.stringify(one)}\n\n`).join('')

test('a streamed answer comes out piece by piece, text, thinking and a tool call', () => {
  const reader = streamReader()
  const body =
    sse(
      { type: 'message_start', message: { usage: { input_tokens: 50, cache_read_input_tokens: 40 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pensando' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Vou ' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ler.' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_9', name: 'Read', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"/a.md"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
    ) + '\n@@HTTP 200'
  // Cut anywhere: a piece may end mid-line.
  const chunks = [...reader.feed(body.slice(0, 333)), ...reader.feed(body.slice(333))]
  const end = reader.finish()
  chunks.push(...end.chunks)

  expect(chunks).toEqual([
    { kind: 'thinking', index: 0, text: 'pensando' },
    { kind: 'text', index: 1, text: 'Vou ' },
    { kind: 'text', index: 1, text: 'ler.' },
    { kind: 'tool', index: 2, id: 'toolu_9', name: 'Read' },
    { kind: 'input', index: 2, json: '{"file_path":' },
    { kind: 'input', index: 2, json: '"/a.md"}' },
  ])
  expect(end.answer).toBe('Vou ler.')
  expect(end.toolUses).toEqual([{ name: 'Read', input: { file_path: '/a.md' } }])
  expect(end.stop).toBe('tool_use')
  expect(end.status).toBe(200)
  expect(end.usage).toEqual({ input_tokens: 50, output_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 40 })
})

test('OpenAI chunks stream too', () => {
  const reader = streamReader()
  const body = [
    { choices: [{ delta: { content: 'Oi' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Bash', arguments: '{"command"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } },
  ]
    .map(one => `data: ${JSON.stringify(one)}\n\n`)
    .join('')
  const chunks = reader.feed(`${body}data: [DONE]\n\n`)
  const end = reader.finish()

  expect(chunks[0]).toEqual({ kind: 'text', index: 0, text: 'Oi' })
  expect(end.toolUses).toEqual([{ name: 'Bash', input: { command: 'ls' } }])
  expect(end.stop).toBe('tool_use')
  expect(end.usage.input_tokens).toBe(9)
})

test('Claude combos get cache marks, the others a plain request', () => {
  const input = {
    system: 'sistema',
    tools: [
      { name: 'Read', description: 'r', input_schema: {} },
      { name: 'Bash', description: 'b', input_schema: {} },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ type: 'text', text: 'b' }, { type: 'text', text: 'c' }] },
    ],
  }
  const claude = JSON.stringify(routerRequest({ ...input, model: 'claude-sonnet-5-5' }))
  const sol = JSON.stringify(routerRequest({ ...input, model: 'gpt-6.1-sol' }))

  expect(claude.match(/cache_control/g)?.length).toBe(4)
  expect(claude).toContain('{"type":"text","text":"c","cache_control"')
  expect(claude).toContain('"stream":true')
  expect(sol).not.toContain('cache_control')
  expect(sol).toContain('"system":"sistema"')
})

test('the deferred list goes grouped, twins and big servers short; skills and MCP notes only for subagents', () => {
  const names = [
    'Bash',
    ...Array.from({ length: 3 }, (_, i) => `mcp__loja__t${i}`),
    ...Array.from({ length: 3 }, (_, i) => `mcp__uuid-1__t${i}`),
    ...Array.from({ length: 200 }, (_, i) => `mcp__grande__f${i}`),
  ]
  const text = [
    'Antes.',
    'The following deferred tools are now available via ToolSearch. Use it:',
    ...names,
    '',
    'The following skills are available for use with the Skill tool:',
    '- rsp-os: Use for an O.S.',
    '- jev: Use Jev.',
    'Depois.',
    '# MCP Server Instructions',
    'longo texto do servidor',
  ].join('\n')
  const cuts = { listaDeFerramentas: 0, skills: 0, instrucoesMcp: 0, bytesCortados: 0 }
  const forMain = trimText(text, false, cuts)
  const forAgent = trimText(text, true, { ...cuts })

  expect(forMain).toContain('mcp__loja__*: t0, t1, t2')
  expect(forMain).toContain('mcp__uuid-1__*: the same 3 tools as mcp__loja__*')
  expect(forMain).toContain('mcp__grande__*: 200 tools')
  expect(forMain).not.toContain('f150')
  expect(forMain).toContain('- rsp-os: Use for an O.S.')
  expect(forMain).toContain('longo texto do servidor')
  expect(forAgent).toContain('Skills (use Skill with the name): rsp-os, jev')
  expect(forAgent).toContain('Depois.')
  expect(forAgent).not.toContain('longo texto do servidor')
  expect(cuts.bytesCortados).toBeGreaterThan(1000)
  expect(summarizeTools(['Read'])).toContain('Built-in: Read')
})

test('/provedor sol turns 9router on with that combo, /provedor claude turns it off', async ($, on) => {
  routed(on, { 'chave-9router': 'k' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const on9 = await $.command.run({ command: 'provedor', args: 'modelo-b' } as never)
  expect(JSON.stringify(on9)).toContain('combo modelo-b')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(JSON.stringify(await ui.find({ key: 'chave' }))).toContain('● 9router')
  await ui.unmount()

  const off = await $.command.run({ command: 'provedor', args: 'claude' } as never)
  expect(JSON.stringify(off)).toContain('Claude')
  const list = await $.command.run({ command: 'provedor', args: '' } as never)
  expect(JSON.stringify(list)).toContain('modelo-a, modelo-b')
})
test('a tool name the Claude combos stream with _ide comes back as offered', () => {
  const reader = streamReader(toolNameFor(new Set(['Read', 'mcp__a__b'])))
  const chunks = reader.feed(
    sse(
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Read_ide', input: {} } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't2', name: 'Outro_ide', input: {} } },
      { type: 'content_block_stop', index: 1 },
    ),
  )

  expect(chunks.filter(one => one.kind === 'tool').map(one => (one as { name: string }).name)).toEqual(['Read', 'Outro_ide'])
  expect(toolNameFor(new Set(['Read']))('Read_ide_ide')).toBe('Read')
})
test('what a tool read reaches the model as it is; only the engine notices are cut', () => {
  const file = ['const SKILLS_HEADER = 1', 'The following skills are available for use with the Skill tool:', '- a: b', '# MCP Server Instructions', 'resto do arquivo'].join('\n')
  const notice = [
    '<system-reminder>',
    'The following skills are available for use with the Skill tool:',
    '- rsp-os: O.S.',
    '</system-reminder>',
    '<system-reminder>',
    '# MCP Server Instructions',
    'notas longas',
    '</system-reminder>',
  ].join('\n')
  const { messages, cuts } = forProvider(
    [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: file }] },
          { type: 'text', text: notice },
        ],
      },
    ],
    true,
  )
  const sent = JSON.stringify(messages)

  expect(sent).toContain('resto do arquivo')
  expect(sent).toContain('- a: b')
  expect(sent).toContain('Skills (use Skill with the name): rsp-os')
  expect(sent).not.toContain('notas longas')
  expect(sent.match(/<\/system-reminder>/g)?.length).toBe(2)
  expect(cuts.skills).toBe(1)
})

test('a tool call cut off midway is not run, and says so', async ($, on) => {
  routed(on, { 'chave-9router': 'k' })
  viaSpawn(on, () =>
    curl(
      sse(
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Read', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/a' } },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
      ) + '\n@@HTTP 200',
    ),
  )
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'chave' })
  const chunks: { kind: string }[] = []
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 1 })
  let step = await stream.next()
  while (!step.done) {
    chunks.push(step.value)
    step = await stream.next()
  }
  await ui.unmount()

  expect(step.value.toolUses).toEqual([])
  expect(chunks.some(one => one.kind === 'tool')).toBe(false)
  expect(step.value.answer).toContain('não foi executada')
})

test('a network failure before any answer is tried once more', async ($, on) => {
  routed(on, { 'chave-9router': 'k' })
  let calls = 0
  viaSpawn(on, () => {
    calls += 1

    return calls === 1 ? curl('', 7, 'connect failed') : curl(OK)
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'chave' })
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'opus', messageCount: 1 })
  let step = await stream.next()
  while (!step.done) {
    step = await stream.next()
  }
  await ui.unmount()

  expect(calls).toBe(2)
  expect(step.value.answer).toBe('pronto')
})
test('a big tool result from an earlier turn is cut to its ends; this turn stays whole', () => {
  const big = 'A'.repeat(3000) + 'MEIO'.repeat(3000) + 'Z'.repeat(1500)
  const out = shortenOldResults([
    { role: 'user', content: [{ type: 'text', text: 'leia o arquivo' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: big }] }] },
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>aviso</system-reminder>' }] },
    { role: 'user', content: [{ type: 'text', text: 'agora outra coisa' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: big }] },
  ])
  const old = JSON.stringify(out.messages[2])
  const recent = JSON.stringify(out.messages[6])

  expect(out.count).toBe(1)
  expect(old).toContain('omitidos para economizar')
  expect(old).toContain('AAAA')
  expect(old).toContain('ZZZZ')
  expect(old.length).toBeLessThan(5000)
  expect(recent.length).toBeGreaterThan(big.length)
})

test('a key typed in the band registers the combos as subagents at once', async ($, on) => {
  routed(on, {})
  const registered: string[] = []
  on('agent.register', (_, e) => {
    registered.push(e.name)

    return { value: { agent: `provedores:${e.name}` } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(registered).toEqual([])
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'chave' })
  await ui.input({ key: 'chave-api', text: 'nova-chave' })
  for (let wait = 0; wait < 20 && registered.length < 2; wait += 1) {
    for (let tick = 0; tick < 50; tick += 1) {
      await Promise.resolve()
    }
  }
  await ui.unmount()

  expect([...registered].sort()).toEqual(['modelo-a', 'modelo-b'])
})
test('with no address the band asks for it, and /provedor url saves it and loads the combos', async ($, on) => {
  const store: Record<string, string> = { 'chave-9router': 'k' }
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = String(e.value)

    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'provedor' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('agent.register', (_, e) => ({ value: { agent: `provedores:${e.name}` } }))
  const asked: string[] = []
  on('http.fetch', (_, e) => {
    asked.push(e.url)

    return { value: { status: 200, ok: true, headers: {}, text: '{"data":[{"id":"meu-combo","owned_by":"combo"}]}' } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(asked).toEqual([])
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'chave' })
  expect(JSON.stringify(await ui.find({ key: 'url-api' }))).toContain('Endereço do 9router')
  await ui.unmount()

  const saved = await $.command.run({ command: 'provedor', args: 'url https://meu.router/v1/' } as never)
  expect(JSON.stringify(saved)).toContain('meu-combo')
  expect(store['url-9router']).toBe('https://meu.router/v1')
  expect(asked[0]).toBe('https://meu.router/v1/models')
})