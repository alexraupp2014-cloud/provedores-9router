import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const FALLBACK_MODELS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-4-5',
  'gpt-6.1-sol',
  'gpt-6-luna',
  'Antygravit',
  'Free',
]
const KEY_STORE = 'chave-9router'
// Each person's own 9router address, typed once.
const URL_STORE = 'url-9router'
const MAX_TOKENS = 16000

const isRouterOn = atom({ plugin: 'provedores', key: 'isRouterOn' } as const, false)
// The fastest combo in the measurements; Antygravit took 50 s and more.
const model = atom({ plugin: 'provedores', key: 'model' } as const, 'gpt-6.1-sol')
const models = atom({ plugin: 'provedores', key: 'models' } as const, FALLBACK_MODELS)
const hasKey = atom({ plugin: 'provedores', key: 'hasKey' } as const, false)
const hasUrl = atom({ plugin: 'provedores', key: 'hasUrl' } as const, false)

// Short names for the models the person calls by name.
const AGENT_ALIASES: Record<string, string> = { sol: 'gpt-6.1-sol', antigravity: 'Antygravit' }
const AGENT_PROMPT = `Você é um subagente respondendo pelo 9router. Faça a tarefa pedida usando as ferramentas disponíveis e termine com o resultado em texto, porque só a sua última mensagem volta para quem chamou. Não invente resultados: se algo falhar, diga o que falhou.`

// An agent type's name takes letters, digits, `_` and `-`, up to 64.
export const agentNameFor = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)

export function routerAgents(ids: readonly string[]) {
  const byName = new Map<string, string>()
  for (const id of ids) {
    byName.set(agentNameFor(id), id)
  }
  for (const [alias, id] of Object.entries(AGENT_ALIASES)) {
    if (ids.includes(id)) {
      byName.set(alias, id)
    }
  }

  return byName
}

const str = (description: string) => ({ type: 'string', description })
const num = (description: string) => ({ type: 'number', description })
const bool = (description: string) => ({ type: 'boolean', description })
const shell = {
  type: 'object',
  required: ['command'],
  properties: {
    command: str('The command to run'),
    timeout: num('Timeout in milliseconds'),
    description: str('What the command does'),
    run_in_background: bool('Run detached'),
  },
}

// The engine hands a mod no tool schemas, so the common tools are written here.
// A tool missing from this table is not offered to a 9router model.
const TOOL_SCHEMAS: Record<string, { description: string; input_schema: unknown }> = {
  ToolSearch: {
    description:
      'Loads any other tool of this session so you can call it: connectors and MCP tools included. The names are in the deferred tools list of the conversation. Use query "select:<name>,<name>" for exact names, or keywords to search. After it answers, call the tool directly.',
    input_schema: {
      type: 'object',
      required: ['query', 'max_results'],
      properties: {
        query: str('"select:<name>,<name>", or keywords'),
        max_results: num('How many tools at most'),
      },
    },
  },
  Read: {
    description: 'Read a file from the local filesystem.',
    input_schema: {
      type: 'object',
      required: ['file_path'],
      properties: {
        file_path: str('Absolute path'),
        offset: num('First line to read'),
        limit: num('How many lines to read'),
      },
    },
  },
  Write: {
    description: 'Write a file, overwriting it. Read an existing file first.',
    input_schema: {
      type: 'object',
      required: ['file_path', 'content'],
      properties: { file_path: str('Absolute path'), content: str('Whole file content') },
    },
  },
  Edit: {
    description: 'Replace an exact, unique string in a file. Read the file first.',
    input_schema: {
      type: 'object',
      required: ['file_path', 'old_string', 'new_string'],
      properties: {
        file_path: str('Absolute path'),
        old_string: str('Exact text to replace'),
        new_string: str('Replacement text'),
        replace_all: bool('Replace every occurrence'),
      },
    },
  },
  Glob: {
    description: 'Find files by glob pattern.',
    input_schema: {
      type: 'object',
      required: ['pattern'],
      properties: { pattern: str('Glob pattern'), path: str('Directory to search') },
    },
  },
  Grep: {
    description: 'Search file contents with a regular expression.',
    input_schema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: str('Regular expression'),
        path: str('File or directory'),
        glob: str('File filter'),
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
        },
        '-i': bool('Case insensitive'),
        head_limit: num('Limit results'),
      },
    },
  },
  Bash: { description: 'Run a command in Git Bash.', input_schema: shell },
  PowerShell: { description: 'Run a Windows PowerShell command.', input_schema: shell },
  WebFetch: {
    description: 'Fetch a web page and answer a question about it.',
    input_schema: {
      type: 'object',
      required: ['url', 'prompt'],
      properties: { url: str('The URL'), prompt: str('What to extract') },
    },
  },
}

type Block = { type: string; [key: string]: unknown }

// Signed thinking belongs to the model that wrote it: another provider refuses it.
// ToolSearch answers with `tool_reference` blocks, which only Anthropic's own
// API expands: anyone else reads a sentence, and the mod sends the schema.
const withoutToolReferences = (block: Block): Block => {
  const content = (block as { content?: unknown }).content
  if (block.type !== 'tool_result' || !Array.isArray(content)) {
    return block
  }

  return {
    ...block,
    content: content.map((one: { type?: unknown; tool_name?: unknown }) =>
      one.type === 'tool_reference'
        ? { type: 'text', text: `Ferramenta carregada: ${String(one.tool_name)}. Já pode chamá-la.` }
        : one,
    ),
  } as Block
}

// The engine lists every deferred tool by name in the conversation, about 60 KB
// with these connectors. ToolSearch finds a tool by keywords too, so the list
// goes out grouped by server, and the big servers as a count.
const DEFERRED_HEADER = 'deferred tools are now available via ToolSearch'
const SKILLS_HEADER = 'skills are available for use with the Skill tool'
const MCP_HEADER = '# MCP Server Instructions'
const NAME_LINE = /^\s*[\w.:@/-]+\s*$/
const BIG_SERVER = 150

export function summarizeTools(names: readonly string[]) {
  const plain: string[] = []
  const servers = new Map<string, string[]>()
  for (const name of names) {
    const match = /^mcp__(.+?)__(.+)$/.exec(name)
    if (match) {
      const [, server = '', tool = ''] = match
      const list = servers.get(server) ?? []
      list.push(tool)
      servers.set(server, list)
    } else {
      plain.push(name)
    }
  }
  const seen = new Map<string, string>()
  const lines = [
    'Listed by server as mcp__<server>__<tool>. Load one with ToolSearch "select:<full name>", or search by keywords.',
  ]
  if (plain.length > 0) {
    lines.push(`Built-in: ${plain.join(', ')}`)
  }
  for (const [server, tools] of servers) {
    const key = [...tools].sort().join(',')
    const twin = seen.get(key)
    if (twin) {
      lines.push(`mcp__${server}__*: the same ${tools.length} tools as mcp__${twin}__*`)
    } else if (tools.length > BIG_SERVER) {
      lines.push(`mcp__${server}__*: ${tools.length} tools, e.g. ${tools.slice(0, 8).join(', ')}; search by keywords`)
    } else {
      lines.push(`mcp__${server}__*: ${tools.join(', ')}`)
    }
    seen.set(key, server)
  }

  return lines.join('\n')
}

export type Cuts = { listaDeFerramentas: number; skills: number; instrucoesMcp: number; bytesCortados: number }

export function trimText(text: string, isSubagent: boolean, cuts: Cuts) {
  if (!text.includes(DEFERRED_HEADER) && !text.includes(SKILLS_HEADER) && !text.includes(MCP_HEADER)) {
    return text
  }
  const lines = text.split('\n')
  const lineAt = (at: number) => lines[at] ?? ''
  const out: string[] = []
  for (let at = 0; at < lines.length; at += 1) {
    const line = lineAt(at)
    if (line.includes(DEFERRED_HEADER)) {
      out.push(line)
      const names: string[] = []
      while (at + 1 < lines.length && lineAt(at + 1).trim() && NAME_LINE.test(lineAt(at + 1))) {
        at += 1
        names.push(lineAt(at).trim())
      }
      if (names.length > 0) {
        out.push(summarizeTools(names))
        cuts.listaDeFerramentas += 1
      }
    } else if (isSubagent && line.includes(SKILLS_HEADER)) {
      const skills: string[] = []
      while (at + 1 < lines.length && lineAt(at + 1).startsWith('- ')) {
        at += 1
        skills.push((lineAt(at).slice(2).split(':')[0] ?? '').trim())
      }
      if (skills.length > 0) {
        out.push(`Skills (use Skill with the name): ${skills.join(', ')}`)
        cuts.skills += 1
      } else {
        out.push(line)
      }
    } else if (isSubagent && line.trim() === MCP_HEADER) {
      // The servers' own usage notes run to the end of this reminder.
      out.push('(MCP server instructions left out for a subagent.)')
      cuts.instrucoesMcp += 1
      while (at + 1 < lines.length && !lineAt(at + 1).includes('</system-reminder>')) {
        at += 1
      }
    } else {
      out.push(line)
    }
  }
  const result = out.join('\n')
  cuts.bytesCortados += text.length - result.length

  return result
}

// Only the engine's own notices are cut, never what a tool read: a file that
// quotes these headers (this very mod does) must reach the model as it is.
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

export const trimReminders = (text: string, isSubagent: boolean, cuts: Cuts) =>
  text.includes('<system-reminder>') ? text.replace(REMINDER, span => trimText(span, isSubagent, cuts)) : text

const trimBlock = (block: Block, isSubagent: boolean, cuts: Cuts): Block => {
  if (block.type === 'text' && typeof block.text === 'string') {
    return { ...block, text: trimReminders(block.text, isSubagent, cuts) }
  }
  const content = (block as { content?: unknown }).content
  if (block.type === 'tool_result' && typeof content === 'string') {
    return { ...block, content: trimReminders(content, isSubagent, cuts) } as Block
  }
  if (block.type === 'tool_result' && Array.isArray(content)) {
    return {
      ...block,
      content: content.map((one: Block) => trimBlock(one, isSubagent, cuts)),
    } as Block
  }

  return block
}

export const forProvider = (messages: readonly { role: string; content: readonly Block[] }[], isSubagent = false) => {
  const cuts: Cuts = { listaDeFerramentas: 0, skills: 0, instrucoesMcp: 0, bytesCortados: 0 }
  const out = messages
    .map(m => ({
      role: m.role,
      content: m.content
        .filter(b => b.type !== 'thinking' && b.type !== 'redacted_thinking')
        .map(withoutToolReferences)
        .map(block => trimBlock(block, isSubagent, cuts)),
    }))
    .filter(m => m.content.length > 0)

  return { messages: out, cuts }
}

// A combo with no cache pays every old tool result again on every step. A
// result from an earlier turn (before the person's last message) is cut to
// its start and end, once: from the next step on that prefix stays the same,
// which keeps the providers' own automatic prefix cache working.
const OLD_RESULT_LIMIT = 8000
const OLD_RESULT_HEAD = 2500
const OLD_RESULT_TAIL = 1000

const isPrompt = (message: { role: string; content: readonly Block[] }) =>
  message.role === 'user' &&
  !message.content.some(block => block.type === 'tool_result') &&
  message.content.some(
    block => block.type === 'text' && typeof block.text === 'string' && block.text.replace(REMINDER, '').trim() !== '',
  )

export function shortenOldResults(messages: readonly { role: string; content: readonly Block[] }[]) {
  let lastPrompt = -1
  messages.forEach((message, at) => {
    if (isPrompt(message)) {
      lastPrompt = at
    }
  })
  let count = 0
  let bytes = 0
  const shorten = (block: Block): Block => {
    const content = (block as { content?: unknown }).content
    const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content
    if (!Array.isArray(parts) || !parts.every((one: Block) => one.type === 'text' && typeof one.text === 'string')) {
      return block
    }
    const whole = parts.map((one: Block) => String(one.text)).join('\n')
    if (whole.length <= OLD_RESULT_LIMIT) {
      return block
    }
    const left = whole.length - OLD_RESULT_HEAD - OLD_RESULT_TAIL
    count += 1
    bytes += left

    return {
      ...block,
      content: `${whole.slice(0, OLD_RESULT_HEAD)}\n[... ${left} caracteres de um resultado antigo omitidos para economizar; rode a ferramenta de novo se precisar ...]\n${whole.slice(-OLD_RESULT_TAIL)}`,
    } as Block
  }
  const out = messages.map((message, at) =>
    at >= lastPrompt
      ? message
      : { ...message, content: message.content.map(block => (block.type === 'tool_result' ? shorten(block) : block)) },
  )

  return { messages: out, count, bytes }
}

// Anthropic caches a prefix up to each marked block. The 9router passes the
// marks on to its Claude combos (measured: 80 thousand tokens read back);
// the other combos get the request without them.
const EPHEMERAL = { type: 'ephemeral' } as const

export function routerRequest(input: {
  model: string
  system: string | undefined
  tools: readonly { name: string; description: string; input_schema: unknown }[]
  messages: readonly { role: string; content: readonly Block[] }[]
}) {
  const isClaude = /^claude/i.test(input.model)
  const base = { model: input.model, max_tokens: MAX_TOKENS, stream: true }
  if (!isClaude) {
    return { ...base, system: input.system, tools: [...input.tools], messages: [...input.messages] }
  }

  const tools = input.tools.map((tool, at) =>
    at === input.tools.length - 1 ? { ...tool, cache_control: EPHEMERAL } : tool,
  )
  // The last message and the user message before it: the next step finds the
  // prefix it wrote at the earlier mark even after many tool calls.
  const last = input.messages.length - 1
  let earlier = -1
  for (let at = last - 1; at >= 0; at -= 1) {
    if (input.messages[at]?.role === 'user') {
      earlier = at
      break
    }
  }
  const messages = input.messages.map((message, at) =>
    (at === last || at === earlier) && message.content.length > 0
      ? {
          ...message,
          content: message.content.map((block, place) =>
            place === message.content.length - 1 ? { ...block, cache_control: EPHEMERAL } : block,
          ),
        }
      : message,
  )

  return {
    ...base,
    system: input.system ? [{ type: 'text', text: input.system, cache_control: EPHEMERAL }] : undefined,
    tools,
    messages,
  }
}

type StepChunk =
  | { kind: 'text'; index: number; text: string }
  | { kind: 'thinking'; index: number; text: string }
  | { kind: 'tool'; index: number; id: string; name: string }
  | { kind: 'input'; index: number; json: string }

const STATUS_MARK = '\n@@HTTP '

// Reads the 9router's answer as it streams: Anthropic's server-sent events,
// OpenAI's chunks, or (no events at all) one JSON body at the end.
// The 9router's Claude combos add `_ide` to every tool name and take it off
// again only in an answer that does not stream: a name the request did not
// offer goes back to the one it did.
export const toolNameFor = (offered: ReadonlySet<string>) => (name: string) => {
  let plain = name
  while (!offered.has(plain) && plain.endsWith('_ide')) {
    plain = plain.slice(0, -'_ide'.length)
  }

  return offered.has(plain) ? plain : name
}

export function streamReader(rename: (name: string) => string = name => name) {
  let pending = ''
  let raw = ''
  let sawStream = false
  let nextIndex = 0
  let answer = ''
  let stop: unknown
  let error = ''
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  type Open = { kind: 'text' | 'thinking' | 'tool'; at: number; id?: string; name?: string; json: string; preset?: string }
  const open = new Map<string, Open>()
  const tools: Open[] = []

  const start = (key: string, kind: Open['kind'], extra: Partial<Open> = {}) => {
    const block: Open = { kind, at: nextIndex, json: '', ...extra }
    nextIndex += 1
    open.set(key, block)
    if (kind === 'tool') {
      tools.push(block)
    }

    return block
  }
  const text = (block: Open, piece: string): StepChunk[] => {
    if (!piece) {
      return []
    }
    if (block.kind === 'thinking') {
      return [{ kind: 'thinking', index: block.at, text: piece }]
    }
    answer += piece

    return [{ kind: 'text', index: block.at, text: piece }]
  }
  const input = (block: Open, piece: string): StepChunk[] => {
    if (!piece) {
      return []
    }
    block.json += piece

    return [{ kind: 'input', index: block.at, json: piece }]
  }
  const readUsage = (from: Record<string, unknown> | undefined) => {
    if (!from) {
      return
    }
    const number = (value: unknown) => (typeof value === 'number' ? value : undefined)
    usage.input_tokens = number(from.input_tokens) ?? number(from.prompt_tokens) ?? usage.input_tokens
    usage.output_tokens = number(from.output_tokens) ?? number(from.completion_tokens) ?? usage.output_tokens
    usage.cache_read_input_tokens = number(from.cache_read_input_tokens) ?? usage.cache_read_input_tokens
    usage.cache_creation_input_tokens = number(from.cache_creation_input_tokens) ?? usage.cache_creation_input_tokens
  }

  // eslint-disable-next-line complexity
  const handle = (data: Record<string, any>): StepChunk[] => {
    const out: StepChunk[] = []
    if (Array.isArray(data.choices)) {
      const choice = data.choices[0] ?? {}
      const delta = choice.delta ?? {}
      const thought = delta.reasoning_content ?? delta.reasoning
      if (typeof thought === 'string' && thought) {
        const block = open.get('oa-think') ?? start('oa-think', 'thinking')
        out.push(...text(block, thought))
      }
      if (typeof delta.content === 'string' && delta.content) {
        const block = open.get('oa-text') ?? start('oa-text', 'text')
        out.push(...text(block, delta.content))
      }
      for (const call of delta.tool_calls ?? []) {
        const key = `oa-tool-${String(call.index ?? 0)}`
        let block = open.get(key)
        if (!block) {
          // Text after a tool call is a block of its own, in order.
          open.delete('oa-text')
          open.delete('oa-think')
          block = start(key, 'tool', { id: call.id ?? `call_${nextIndex}`, name: rename(call.function?.name ?? '') })
          out.push({ kind: 'tool', index: block.at, id: block.id ?? '', name: block.name ?? '' })
        }
        out.push(...input(block, call.function?.arguments ?? ''))
      }
      if (choice.finish_reason) {
        stop =
          choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn'
      }
      readUsage(data.usage)

      return out
    }

    const key = String(data.index ?? 0)
    switch (data.type) {
      case 'message_start':
        readUsage(data.message?.usage)
        break
      case 'content_block_start': {
        const block = data.content_block ?? {}
        if (block.type === 'text') {
          out.push(...text(start(key, 'text'), block.text ?? ''))
        } else if (block.type === 'thinking') {
          out.push(...text(start(key, 'thinking'), block.thinking ?? ''))
        } else if (block.type === 'tool_use') {
          const preset = block.input && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : undefined
          const opened = start(key, 'tool', { id: block.id ?? `call_${nextIndex}`, name: rename(block.name ?? ''), preset })
          out.push({ kind: 'tool', index: opened.at, id: opened.id ?? '', name: opened.name ?? '' })
        }
        break
      }
      case 'content_block_delta': {
        const block = open.get(key)
        const delta = data.delta ?? {}
        if (block && delta.type === 'text_delta') {
          out.push(...text(block, delta.text ?? ''))
        } else if (block && delta.type === 'thinking_delta') {
          out.push(...text(block, delta.thinking ?? ''))
        } else if (block && delta.type === 'input_json_delta') {
          out.push(...input(block, delta.partial_json ?? ''))
        }
        break
      }
      case 'content_block_stop': {
        const block = open.get(key)
        if (block?.kind === 'tool' && block.json === '') {
          out.push(...input(block, block.preset ?? '{}'))
        }
        open.delete(key)
        break
      }
      case 'message_delta':
        stop = data.delta?.stop_reason ?? stop
        readUsage(data.usage)
        break
      case 'error':
        error = String(data.error?.message ?? JSON.stringify(data.error ?? data))
        break
      default:
    }

    return out
  }

  const lines = (block: string): StepChunk[] => {
    const out: StepChunk[] = []
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) {
        continue
      }
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') {
        continue
      }
      try {
        const parsed = JSON.parse(data)
        sawStream = true
        out.push(...handle(parsed))
      } catch {
        // A line that is not JSON is no event.
      }
    }

    return out
  }

  return {
    feed(piece: string): StepChunk[] {
      raw += piece
      pending += piece
      const cut = pending.lastIndexOf('\n')
      if (cut < 0) {
        return []
      }
      const whole = pending.slice(0, cut)
      pending = pending.slice(cut + 1)

      return lines(whole)
    },
    finish() {
      const chunks = lines(pending)
      pending = ''
      const mark = raw.lastIndexOf(STATUS_MARK)
      const status = mark >= 0 ? Number(raw.slice(mark + STATUS_MARK.length).trim()) : undefined
      const body = mark >= 0 ? raw.slice(0, mark) : raw

      if (!sawStream && body.trim().startsWith('{') && (status === undefined || (status >= 200 && status < 300))) {
        // No events: the whole answer came as one body.
        try {
          const parsed = normalize(JSON.parse(body))
          for (const block of parsed.content ?? []) {
            if (block.type === 'text' && typeof block.text === 'string' && block.text) {
              chunks.push(...text(start(`b${nextIndex}`, 'text'), block.text))
            } else if (block.type === 'tool_use') {
              const opened = start(`b${nextIndex}`, 'tool', { id: String(block.id), name: rename(String(block.name)) })
              chunks.push({ kind: 'tool', index: opened.at, id: opened.id ?? '', name: opened.name ?? '' })
              chunks.push(...input(opened, JSON.stringify(block.input ?? {})))
            }
          }
          stop = parsed.stop_reason
          readUsage(parsed.usage as Record<string, unknown> | undefined)
        } catch {
          // Shown as it came below.
        }
      }

      for (const block of open.values()) {
        if (block.kind === 'tool' && block.json === '') {
          chunks.push(...input(block, block.preset ?? '{}'))
        }
      }

      // Arguments that do not parse were cut off: such a call must not run.
      const broken: string[] = []
      const toolUses = tools.map(block => {
        let parsed: unknown = {}
        try {
          parsed = JSON.parse(block.json || '{}')
        } catch {
          broken.push(block.name ?? '')
        }

        return { name: block.name ?? '', input: parsed }
      })

      return { chunks, answer, toolUses, broken, stop, usage, status, raw: body, sawStream, error, nextIndex }
    },
  }
}

export type RouterBody = {
  content?: Block[]
  stop_reason?: unknown
  usage?: { input_tokens?: number; output_tokens?: number }
}

// The 9router may answer in OpenAI's shape (`choices`) even on /messages:
// fold it into the blocks Anthropic's shape has.
export const normalize = (raw: unknown): RouterBody => {
  const openai = raw as {
    content?: Block[]
    choices?: {
      finish_reason?: string
      message?: {
        content?: string | null
        tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]
      }
    }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const choice = openai.choices?.[0]
  if (!choice?.message || openai.content !== undefined) {
    return raw as RouterBody
  }
  const blocks: Block[] = []
  if (typeof choice.message.content === 'string' && choice.message.content) {
    blocks.push({ type: 'text', text: choice.message.content })
  }
  for (const call of choice.message.tool_calls ?? []) {
    let input: unknown = {}
    try {
      input = JSON.parse(call.function?.arguments || '{}')
    } catch {
      input = {}
    }
    blocks.push({ type: 'tool_use', id: call.id ?? `call_${blocks.length}`, name: call.function?.name ?? '', input })
  }

  return {
    content: blocks,
    stop_reason:
      choice.finish_reason === 'tool_calls'
        ? 'tool_use'
        : choice.finish_reason === 'length'
          ? 'max_tokens'
          : 'end_turn',
    usage: {
      input_tokens: openai.usage?.prompt_tokens ?? 0,
      output_tokens: openai.usage?.completion_tokens ?? 0,
    },
  }
}

const STOP_REASONS = ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'refusal'] as const
type Stop = (typeof STOP_REASONS)[number]
const asStop = (value: unknown): Stop =>
  STOP_REASONS.find(reason => reason === value) ?? 'end_turn'

const headersFor = (key: string) => ({
  authorization: `Bearer ${key}`,
  'anthropic-version': '2023-06-01',
  'content-type': 'application/json',
})

// `$.http.fetch` gives up after 30 s, too short for a model that thinks.
// curl may wait up to ten minutes; the key and body go in on stdin, so
// neither shows in the process list.
type Runs = {
  process: {
    run: (
      argv: readonly string[],
      init?: { stdin?: string; timeoutMs?: number },
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  }
}
type Lists = { tool: { list: () => Promise<readonly { name: string; description: string }[]> } }
type ToolSpecs = Record<string, { description?: string; input_schema?: unknown }>
type Fetches = {
  http: { fetch(url: string, init?: { headers?: Record<string, string> }): Promise<{ ok: boolean; text: string }> }
}
type Registers = {
  agent: {
    register(spec: {
      name: string
      description: string
      prompt: string
      model?: string
      disallowedTools?: readonly string[]
    }): Promise<unknown>
  }
}

export function curlConfig(baseUrl: string, key: string, payload: string) {
  const quote = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

  return [
    `url = ${quote(`${baseUrl}/messages`)}`,
    'request = "POST"',
    ...Object.entries(headersFor(key)).map(([name, value]) => `header = ${quote(`${name}: ${value}`)}`),
    `data-binary = ${quote(payload)}`,
    `write-out = "${STATUS_MARK.replace('\n', '\\n')}%{http_code}"`,
  ].join('\n')
}

async function post($: Runs, baseUrl: string, key: string, payload: string) {
  const run = await $.process.run(['curl', '-sS', '--max-time', '280', '--config', '-'], {
    stdin: curlConfig(baseUrl, key, payload),
    timeoutMs: 290000,
  })
  if (run.exitCode !== 0) {
    throw new Error(`curl ${run.exitCode}: ${run.stderr.slice(0, 200)}`)
  }
  const cut = run.stdout.lastIndexOf(STATUS_MARK)
  if (cut < 0) {
    return { status: 0, ok: false, text: run.stdout }
  }
  const status = Number(run.stdout.slice(cut + STATUS_MARK.length))

  return { status, ok: status >= 200 && status < 300, text: run.stdout.slice(0, cut) }
}

// Every tool's schema together is about 500 thousand tokens, more than a model
// holds: the common ones always go, any other once ToolSearch has loaded it.
async function offeredTools($: Lists, loaded: ReadonlySet<string>, readSpecs: () => Promise<ToolSpecs>) {
  const list = await $.tool.list()
  const offered = list.map(tool => tool.name)
  const front = Object.entries(TOOL_SCHEMAS)
    .filter(([name]) => offered.length === 0 || offered.includes(name))
    .map(([name, spec]) => ({ name, ...spec }))
  const extra = list.filter(tool => loaded.has(tool.name) && !(tool.name in TOOL_SCHEMAS))
  if (extra.length === 0) {
    return front
  }

  const specs = await readSpecs()

  return [
    ...front,
    ...extra.map(tool => ({
      name: tool.name,
      description: specs[tool.name]?.description || tool.description || tool.name,
      // A tool newer than esquemas.json still goes, its input left open.
      input_schema: specs[tool.name]?.input_schema ?? { type: 'object', additionalProperties: true },
    })),
  ]
}

// The tools a conversation has already called must stay declared.
const calledIn = (messages: readonly { content: readonly Block[] }[]) => {
  const names: string[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        names.push(block.name)
      }
    }
  }

  return names
}

// The 9router's combos, the ones it marks `owned_by: "combo"`.
async function combosOf($: Fetches, baseUrl: string, key: string): Promise<readonly string[]> {
  try {
    const res = await $.http.fetch(`${baseUrl}/models`, { headers: headersFor(key) })
    if (res.ok) {
      const data: { id?: unknown; owned_by?: unknown }[] = JSON.parse(res.text).data ?? []
      const combos = data
        .filter(one => one.owned_by === 'combo')
        .map(one => one.id)
        .filter((id: unknown): id is string => typeof id === 'string')
      if (combos.length > 0) {
        return combos
      }
    }
  } catch {
    // The fixed list stays.
  }

  return FALLBACK_MODELS
}

// The picker offers the combos alone; a model picked earlier stays listed.
async function offerCombos($: Parameters<typeof read>[0], combos: readonly string[]) {
  const picked = await read($, model)
  await update($, models, () => (combos.includes(picked) ? [...combos] : [...combos, picked]))
}

// Each combo as a subagent type; answers why one was refused, or ''.
async function registerAgents($: Registers, combos: readonly string[], types: Map<string, string>) {
  types.clear()
  const results = await Promise.allSettled(
    [...routerAgents(combos)].map(async ([name, id]) => {
      await $.agent.register({
        name,
        description: `Subagente 9router, combo ${id}. Use quando pedirem subagentes 9router ou este combo.`,
        prompt: AGENT_PROMPT,
        model: 'inherit',
        disallowedTools: ['Agent'],
      })
      types.set(`provedores:${name}`, id)
    }),
  )
  const refused = results.find(one => one.status === 'rejected')

  return refused?.status === 'rejected' ? String(refused.reason).slice(0, 200) : ''
}

export const register: Register = (on, options) => {
  // No address is built in: each person points the mod at their own 9router.
  let baseUrl = String(options.baseUrl ?? '').replace(/\/+$/, '')
  // `$.prompt.compose` and a `prompt.compose` hook do not exist where a mod runs:
  // the system prompt is read section by section as the engine assembles it.
  const sections = new Map<string, string>()
  // `provedores:<name>` -> the 9router model that type answers with.
  const agentTypes = new Map<string, string>()
  let agentProblem = ''
  // What each loop has loaded through ToolSearch; '' is the main loop.
  const loadedTools = new Map<string, Set<string>>()
  let specs: ToolSpecs | undefined
  // What the last request to the 9router carried, never the key.
  let lastRequest: Record<string, unknown> = {}
  // Sizes are measured when asked, not on every step.
  let lastBody: ReturnType<typeof routerRequest> | undefined
  // agentId -> the combo its type answers with, or null for any other type.
  const agentModels = new Map<string, string | null>()

  on('tool.call', { tool: 'mcp__provedores__ultimo_envio' }, async () => ({
    result: JSON.stringify(
      lastBody
        ? {
            ...lastRequest,
            bytesSistema: JSON.stringify(lastBody.system ?? '').length,
            bytesFerramentas: JSON.stringify(lastBody.tools).length,
            ferramentas: lastBody.tools.length,
            bytesMensagens: JSON.stringify(lastBody.messages).length,
          }
        : lastRequest,
      null,
      1,
    ),
  }))

  on('tool.call', { tool: 'ToolSearch' }, async ($, e, next) => {
    const answer = await next(e)
    const matches = (answer as { result?: { matches?: unknown } }).result?.matches
    if (Array.isArray(matches)) {
      const loop = e.agentId ?? ''
      const seen = loadedTools.get(loop) ?? new Set<string>()
      for (const name of matches) {
        seen.add(String(name))
      }
      loadedTools.set(loop, seen)
    }

    return answer
  })


  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'provedor',
      description: 'Troca o modelo: /provedor sol, /provedor claude; sem nome mostra os combos',
    })
    // A check for whoever asks; the session runs the same without it.
    await $.tool
      .register({
        name: 'ultimo_envio',
        description: 'Shows the size and parts of the last request sent to the 9router (never the key).',
      })
      .catch(() => undefined)
    if (!baseUrl) {
      const saved = await $.store.get(URL_STORE)
      baseUrl = typeof saved === 'string' ? saved : ''
    }
    await update($, hasUrl, () => baseUrl !== '')
    const key = await $.store.get(KEY_STORE)
    await update($, hasKey, () => typeof key === 'string' && key.length > 0)
    const combos = typeof key === 'string' && key && baseUrl ? await combosOf($, baseUrl, key) : FALLBACK_MODELS
    await offerCombos($, combos)

    const started = await next(e)

    // Only with an address and a key: without them these types could only fail.
    if (typeof key === 'string' && key && baseUrl) {
      agentModels.clear()
      agentProblem = await registerAgents($, combos, agentTypes)
    }

    return started
  })

  on('prompt.section', async ($, e, next) => {
    const answer = await next(e)
    if (answer.text) {
      sections.set(e.name, answer.text)
    } else {
      sections.delete(e.name)
    }

    return answer
  })

  on('command.run', { command: 'provedor' }, async ($, e) => {
    const asked = String(e.args ?? '').trim()
    const [word = '', ...rest] = asked.split(/\s+/)
    if (word.toLowerCase() === 'url') {
      const url = rest.join('').replace(/\/+$/, '')
      if (!/^https?:\/\/\S+$/i.test(url)) {
        return { text: 'Use: /provedor url https://seu-9router/v1' }
      }
      await $.store.set(URL_STORE, url)
      baseUrl = url
      await update($, hasUrl, () => true)
      const key = await $.store.get(KEY_STORE)
      if (typeof key === 'string' && key) {
        const combos = await combosOf($, baseUrl, key)
        await offerCombos($, combos)
        agentModels.clear()
        agentProblem = await registerAgents($, combos, agentTypes)

        return { text: `Endereço guardado: ${url}. Combos: ${combos.join(', ')}.` }
      }

      return { text: `Endereço guardado: ${url}. Agora ligue a chave 9router na faixa e cole a sua chave.` }
    }
    if (asked !== 'teste') {
      const combos = await read($, models)
      const wanted = asked.toLowerCase()
      if (wanted === 'claude') {
        await update($, isRouterOn, () => false)
        $.ui.status(undefined)

        return { text: 'Claude, com o seu login.' }
      }
      const alias = Object.hasOwn(AGENT_ALIASES, wanted) ? AGENT_ALIASES[wanted] : undefined
      const found =
        (alias !== undefined && combos.includes(alias) ? alias : undefined) ??
        combos.find(id => id.toLowerCase() === wanted || agentNameFor(id).toLowerCase() === wanted)
      if (asked && found) {
        await update($, model, () => found)
        await update($, isRouterOn, () => true)
        $.ui.status(`9router: ${found}`)

        return { text: `9router, combo ${found}. Para voltar: /provedor claude` }
      }
      const now = (await read($, isRouterOn)) ? `9router, combo ${await read($, model)}` : 'Claude, com o seu login'

      return {
        text: [
          asked ? `Não conheço "${asked}".` : `Agora: ${now}.`,
          `Combos: ${combos.join(', ')}. Atalhos: ${Object.keys(AGENT_ALIASES).join(', ')}.`,
          'Use /provedor <nome> para trocar, /provedor claude para voltar, /provedor teste para checar.',
        ].join('\n'),
      }
    }

    // `/provedor teste`: says where a message would stall, with a tiny request.
    const lines: string[] = []
    const key = await $.store.get(KEY_STORE)
    lines.push(`endereço: ${baseUrl || 'FALTA (use /provedor url https://seu-9router/v1)'}`)
    lines.push(`chave: ${typeof key === 'string' && key ? 'guardada' : 'FALTA'}`)
    lines.push(`modelo: ${await read($, model)}`)
    lines.push(`subagentes: ${agentTypes.size}${agentProblem ? ` (recusa: ${agentProblem})` : ''}`)
    let started = Date.now()
    try {
      const run = await $.process.run(['curl', '--version'], { timeoutMs: 8000 })
      lines.push(`curl: ${run.exitCode === 0 ? 'roda' : `saiu com ${run.exitCode}`} (${Date.now() - started} ms)`)
    } catch (error) {
      lines.push(`curl: NAO roda aqui (${String(error).slice(0, 120)})`)
    }
    if (typeof key === 'string' && key && baseUrl) {
      started = Date.now()
      try {
        const res = await post(
          $,
          baseUrl,
          key,
          JSON.stringify({
            model: await read($, model),
            max_tokens: 20,
            stream: false,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }],
          }),
        )
        lines.push(`resposta curta: HTTP ${res.status} em ${Date.now() - started} ms`)
        if (!res.ok) {
          lines.push(res.text.slice(0, 200))
        }
      } catch (error) {
        lines.push(`resposta curta: FALHOU em ${Date.now() - started} ms (${String(error).slice(0, 120)})`)
      }
    }

    return { text: lines.join('\n') }
  })

  on('turn.step', async function* ($, e, next) {
    // A subagent goes to 9router when its type says so, whatever the switch
    // shows; any other subagent stays on the session's own model.
    const agentId = e.agentId
    let agentModel: string | undefined
    if (agentId !== undefined) {
      // An agent keeps its type: the list is read once per agent, not per step.
      if (!agentModels.has(agentId)) {
        const type = (await $.agent.list()).find(one => one.id === agentId)?.type
        agentModels.set(agentId, type === undefined ? null : (agentTypes.get(type) ?? null))
      }
      agentModel = agentModels.get(agentId) ?? undefined
    }
    if (agentId !== undefined ? agentModel === undefined : !(await read($, isRouterOn))) {
      return yield* next(e)
    }

    const fail = (text: string) => ({
      turnId: e.turnId,
      index: e.index,
      answer: text,
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: null,
    })
    const key = await $.store.get(KEY_STORE)
    if (typeof key !== 'string' || !key) {
      const text = '[provedores] Falta a chave do 9router. Coloque-a na faixa acima da caixa de mensagem.'
      yield { kind: 'text', index: 0, text }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }

      return fail(text)
    }
    if (!baseUrl) {
      const text = '[provedores] Falta o endereço do 9router. Use /provedor url https://seu-9router/v1 ou preencha na faixa.'
      yield { kind: 'text', index: 0, text }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }

      return fail(text)
    }

    const chosen = agentModel ?? (await read($, model))
    const system =
      agentId === undefined
        ? [...sections.values()].join('\n\n') || undefined
        : `${AGENT_PROMPT}\n\nPasta de trabalho: ${await $.session.cwd()}`
    const messages =
      agentId === undefined
        ? await $.session.messages({ as: 'api' })
        : await $.session.messages({ agentId, as: 'api' })
    if ('deny' in messages) {
      const text = `[provedores] Não consegui ler a conversa do subagente: ${String(messages.deny).slice(0, 200)}`
      yield { kind: 'text', index: 0, text }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }

      return fail(text)
    }
    // Agent and Skill go always, as for Claude: subagents and skills with no
    // ToolSearch first. A subagent gets no Agent (filtered below).
    const loaded = new Set([
      ...(loadedTools.get(agentId ?? '') ?? []),
      ...calledIn(messages),
      'Skill',
      ...(agentId === undefined ? ['Agent'] : []),
    ])
    const readSpecs = async () => {
      if (specs === undefined) {
        try {
          specs = JSON.parse(await $.fs.read(`${$.plugin.root}/esquemas.json`)) as ToolSpecs
        } catch {
          specs = {}
        }
      }

      return specs
    }
    const tools = (await offeredTools($, loaded, readSpecs)).filter(
      tool => agentId === undefined || tool.name !== 'Agent',
    )

    const trimmed = forProvider(messages, agentId !== undefined)
    const old = /^claude/i.test(chosen)
      ? { messages: trimmed.messages, count: 0, bytes: 0 }
      : shortenOldResults(trimmed.messages)
    const request = routerRequest({ model: chosen, system, tools, messages: old.messages })
    const payload = JSON.stringify(request)
    lastBody = request
    lastRequest = {
      quando: new Date().toISOString(),
      modelo: chosen,
      subagente: agentId !== undefined,
      bytes: payload.length,
      cortes: trimmed.cuts,
      resultadosAntigos: { encurtados: old.count, caracteresOmitidos: old.bytes },
      cache: request.system !== undefined && typeof request.system !== 'string',
    }

    // The answer streams: each piece of text shows as it comes. Esc ends this
    // hook's dispatch, and the engine kills curl with it. Tool calls are held
    // until the answer is whole, so a call cut off midway never runs.
    const rename = toolNameFor(new Set(request.tools.map(tool => tool.name)))
    const held: StepChunk[] = []
    let shown = false
    let stderr = ''
    let code: number | null = null
    let end: ReturnType<ReturnType<typeof streamReader>['finish']> | undefined
    for (let attempt = 0; end === undefined; attempt += 1) {
      const reader = streamReader(rename)
      stderr = ''
      code = null
      let failed: unknown
      try {
        const stream = $.process.spawn({
          argv: ['curl', '-sS', '-N', '--connect-timeout', '15', '--max-time', '600', '--config', '-'],
          input: curlConfig(baseUrl, key, payload),
        })
        let piece = await stream.next()
        while (!piece.done) {
          if (piece.value.stream === 'stdout') {
            for (const chunk of reader.feed(piece.value.text)) {
              if (chunk.kind === 'tool' || chunk.kind === 'input') {
                held.push(chunk)
              } else {
                shown = true
                yield chunk
              }
            }
          } else {
            stderr += piece.value.text
          }
          piece = await stream.next()
        }
        code = piece.value.code
      } catch (error) {
        failed = error
      }
      const finished = reader.finish()
      // Nothing came yet and the failure may pass (network, 429, 5xx): once more.
      const isEmpty = !shown && held.length === 0 && finished.chunks.length === 0
      const isPassing =
        failed !== undefined ||
        [6, 7, 28, 35, 52, 56].includes(code ?? 0) ||
        (!finished.sawStream && finished.status !== undefined && (finished.status === 429 || finished.status >= 500))
      if (attempt === 0 && isEmpty && isPassing) {
        await $.clock.sleep(1500, { signal: next.signal })
        continue
      }
      if (failed !== undefined && isEmpty) {
        const text = `[provedores] Falha ao falar com o 9router: ${String(failed).slice(0, 300)}`
        yield { kind: 'text', index: 0, text }
        yield { kind: 'stop', stopReason: 'end_turn', usage: null }

        return fail(text)
      }
      if (failed !== undefined) {
        stderr += String(failed)
      }
      end = finished
    }

    for (const chunk of end.chunks) {
      if (chunk.kind === 'tool' || chunk.kind === 'input') {
        held.push(chunk)
      } else {
        shown = true
        yield chunk
      }
    }
    let answer = end.answer
    let next_index = end.nextIndex
    const say = (text: string) => {
      answer += text
      const chunk = { kind: 'text' as const, index: next_index, text }
      next_index += 1

      return chunk
    }

    if (end.status !== undefined && (end.status < 200 || end.status >= 300) && !end.sawStream) {
      const text = `[provedores] O 9router respondeu ${end.status}: ${end.raw.slice(0, 300)}`
      yield { kind: 'text', index: 0, text }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }

      return fail(text)
    }
    if (!shown && held.length === 0 && (code ?? 0) !== 0) {
      const text = `[provedores] Falha ao falar com o 9router: curl ${String(code)}: ${stderr.slice(0, 200)}`
      yield { kind: 'text', index: 0, text }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }

      return fail(text)
    }

    // A call runs only when its answer arrived whole and its arguments parse.
    const cutOff =
      (code ?? 0) !== 0 ? `a conexão caiu (curl ${String(code)})` : asStop(end.stop) === 'max_tokens' ? 'a resposta bateu no limite de tamanho' : ''
    let toolUses = end.toolUses
    if (toolUses.length > 0 && (cutOff || end.broken.length > 0)) {
      const names = (end.broken.length > 0 ? end.broken : toolUses.map(one => one.name)).join(', ')
      yield say(
        `\n\n[provedores] A chamada de ${names} chegou incompleta (${cutOff || 'argumentos cortados'}) e não foi executada. Peça de novo, de preferência em partes menores.`,
      )
      toolUses = []
    } else {
      for (const chunk of held) {
        yield chunk
      }
      if (cutOff && toolUses.length === 0) {
        yield say(`\n\n[provedores] A resposta ficou incompleta: ${cutOff}. ${stderr.slice(0, 160)}`)
      }
    }
    if (end.error) {
      yield say(`\n\n[provedores] O 9router avisou um erro: ${end.error.slice(0, 300)}`)
    }
    if (answer === '' && toolUses.length === 0) {
      // Nothing to show would leave the chat looking stuck: say what came back.
      yield say(
        `[provedores] O 9router (${chosen}) respondeu sem texto. Motivo de parada: ${String(end.stop ?? 'nenhum')}. Início da resposta: ${end.raw.slice(0, 300)}`,
      )
    }

    const stopReason = toolUses.length > 0 ? ('tool_use' as const) : asStop(end.stop)
    const usage = { ...end.usage, model: chosen }
    lastRequest = { ...lastRequest, uso: end.usage, parada: stopReason }
    yield { kind: 'stop', stopReason, usage }

    return { turnId: e.turnId, index: e.index, answer, toolUses, stopReason, usage }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const on9router = await read($, isRouterOn)
    const chosen = await read($, model)
    const list = await read($, models)
    const keyed = await read($, hasKey)
    const located = await read($, hasUrl)
    const setRouter = (value: boolean) => {
      void update($, isRouterOn, () => value)
      $.ui.status(value ? `9router: ${chosen}` : undefined)
    }
    const pick = (value: string) => {
      void update($, model, () => value)
      $.ui.status(`9router: ${value}`)
    }

    if (e.surface === 'mobile') {
      const { Box, Button, Text } = $.ui.resolve(e)

      return (
        <Box flexDirection="column">
          <Button
            key="chave"
            label={on9router ? '○ Claude | ● 9router' : '● Claude | ○ 9router'}
            onPress={() => setRouter(!on9router)}
          />
          {on9router && !located && <Text>Falta o endereço: /provedor url https://seu-9router/v1</Text>}
          {on9router && !keyed && <Text>Falta a chave: coloque-a pelo computador.</Text>}
          {on9router &&
            list.map(id => (
              <Button
                key={`modelo-${id}`}
                label={id === chosen ? `● ${id}` : id}
                onPress={() => pick(id)}
              />
            ))}
        </Box>
      )
    }

    const { Box, Button, Input, Select } = $.ui.resolve(e)

    return (
      <Box>
        <Button
          key="chave"
          label={on9router ? '○ Claude | ● 9router' : '● Claude | ○ 9router'}
          onPress={() => setRouter(!on9router)}
        />
        {on9router && (
          <Select
            key="modelo"
            label=" Modelo:"
            options={list.map(id => ({ value: id }))}
            value={chosen}
            onSelect={pick}
          />
        )}
        {on9router && !located && (
          <Input
            key="url-api"
            label=" Endereço do 9router:"
            placeholder="https://seu-9router/v1 e Enter"
            onSubmit={value => {
              const url = value.trim().replace(/\/+$/, '')
              if (!/^https?:\/\/\S+$/i.test(url)) {
                $.ui.status('9router: o endereço começa com https://')

                return
              }
              void (async () => {
                await $.store.set(URL_STORE, url)
                baseUrl = url
                await update($, hasUrl, () => true)
                const key = await $.store.get(KEY_STORE)
                if (typeof key === 'string' && key) {
                  const combos = await combosOf($, baseUrl, key)
                  await offerCombos($, combos)
                  agentModels.clear()
                  agentProblem = await registerAgents($, combos, agentTypes)
                }
              })().catch(error => {
                $.ui.status(`9router: não consegui guardar o endereço (${String(error).slice(0, 80)})`)
              })
            }}
          />
        )}
        {on9router && located && !keyed && (
          <Input
            key="chave-api"
            label=" Chave do 9router:"
            placeholder="cole e aperte Enter"
            onSubmit={value => {
              // A key typed here works at once: combos and subagents included,
              // with no new session.
              const typed = value.trim()
              void (async () => {
                await $.store.set(KEY_STORE, typed)
                await update($, hasKey, () => typed.length > 0)
                if (typed && baseUrl) {
                  const combos = await combosOf($, baseUrl, typed)
                  await offerCombos($, combos)
                  agentModels.clear()
                  agentProblem = await registerAgents($, combos, agentTypes)
                }
              })().catch(error => {
                $.ui.status(`9router: não consegui guardar a chave (${String(error).slice(0, 80)})`)
              })
            }}
          />
        )}
      </Box>
    )
  })
}
