import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { main, adb } from './adrive.mjs'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const bool = (description) => ({ type: 'boolean', description })
const query = str('Text, content description, or resource ID; exact match first, then substring, case-insensitive')
const nth = num('Zero-based index among matches (default 0)')
const windows = bool('Also search the keyboard, system dialogs, and overlays')
const pkg = str('Package name; defaults to the foreground app')
const target = str('Element query, or "x,y" screen coordinates')

const flag = (on, name) => (on ? [name] : [])
const opt = (value, name) => (value === undefined ? [] : [name, String(value)])
const element = (a) => [...flag(a.windows, '--windows'), ...opt(a.nth, '--nth')]

// Calls run one at a time, so a long wait would block every other tool.
const waiter = (cmd, verb) => ({
  description: `Wait until an element ${verb}, up to 60 seconds.`,
  props: { query, seconds: { ...num('Timeout (default 10)'), maximum: 60 }, windows }, required: ['query'],
  argv: (a) => [cmd, ...flag(a.windows, '--windows'), '--', a.query, ...(a.seconds === undefined ? [] : [String(a.seconds)])],
  readOnly: true,
})

// argv puts flags before `--`, so user text is never read as an option.
const TOOLS = {
  ui: {
    description: 'List visible elements as one line each: class, text/desc/id, flags, @centerX,centerY and [bounds]. Read this before acting.',
    props: { all: bool('Include unlabeled, non-actionable nodes'), windows, json: bool('Return structured JSON instead of text') },
    argv: (a) => ['ui', ...flag(a.all, '--all'), ...flag(a.windows, '--windows'), ...flag(a.json, '--json')],
    readOnly: true,
  },
  tap: {
    description: 'Tap an element or coordinates. Fails without touching the device if nothing matches.',
    props: { target, nth, windows }, required: ['target'],
    argv: (a) => ['tap', ...element(a), '--', a.target],
  },
  longpress: {
    description: 'Long-press an element or coordinates.',
    props: { target, nth, windows }, required: ['target'],
    argv: (a) => ['longpress', ...element(a), '--', a.target],
  },
  slide: {
    description: 'Drag a slider to a fraction of its width.',
    props: { query, fraction: num('0 to 1'), nth, windows }, required: ['query', 'fraction'],
    argv: (a) => ['slide', ...element(a), '--', a.query, String(a.fraction)],
  },
  type: {
    description: 'Type printable ASCII into the focused field.',
    props: { text: str('Literal text') }, required: ['text'],
    argv: (a) => ['type', '--', a.text],
  },
  swipe: {
    description: 'Swipe between two screen points.',
    props: { x1: num('Start x'), y1: num('Start y'), x2: num('End x'), y2: num('End y'), ms: num('Duration in ms (default 300)') },
    required: ['x1', 'y1', 'x2', 'y2'],
    argv: (a) => ['swipe', ...[a.x1, a.y1, a.x2, a.y2].map(String), ...(a.ms === undefined ? [] : [String(a.ms)])],
  },
  scroll: {
    description: 'Scroll the screen content.',
    props: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] } }, required: ['direction'],
    argv: (a) => ['scroll', a.direction],
  },
  key: {
    description: 'Press a key: back, home, enter, del, tab, a KEYCODE_ name, or a numeric keycode.',
    props: { key: str('Key name or code') }, required: ['key'],
    argv: (a) => ['key', String(a.key)],
  },
  wait: waiter('wait', 'appears'),
  gone: waiter('gone', 'disappears'),
  screenshot: {
    description: 'Capture the screen as a PNG image.',
    props: {},
    readOnly: true,
  },
  launch: {
    description: 'Launch an app by package name.',
    props: { package: str('Package name') }, required: ['package'],
    argv: (a) => ['launch', a.package],
  },
  stop: {
    description: 'Force-stop an app.',
    props: { package: str('Package name') }, required: ['package'],
    argv: (a) => ['stop', a.package],
    destructive: true,
  },
  current: {
    description: 'Foreground package/activity.',
    props: {},
    argv: () => ['current'],
    readOnly: true,
  },
  open: {
    description: 'Open a deep link or URL.',
    props: { url: str('URL') }, required: ['url'],
    argv: (a) => ['open', a.url],
  },
  log: {
    description: 'Recent logcat lines from the app\'s current main process.',
    props: { pattern: str('Case-insensitive regex filter'), package: pkg, lines: num('Max lines (default 200)') },
    argv: (a) => ['log', ...opt(a.package, '--package'), ...opt(a.lines, '--lines'), ...(a.pattern ? ['--', a.pattern] : [])],
    readOnly: true,
  },
  log_clear: {
    description: 'Clear logcat, so the next log read shows only what happens after.',
    props: {},
    argv: () => ['log-clear'],
    destructive: true,
  },
  crash: {
    description: 'Last Java crash for the app, plus current ANR/crashing state.',
    props: { package: pkg },
    argv: (a) => ['crash', ...opt(a.package, '--package')],
    readOnly: true,
  },
  perf: {
    description: 'CPU by thread, memory, and frame jank since the last reset.',
    props: { package: pkg, reset: bool('Reset frame stats instead of reading them') },
    argv: (a) => ['perf', ...opt(a.package, '--package'), ...flag(a.reset, '--reset')],
  },
  audio: {
    description: 'The app\'s audio tracks: underruns, buffer sizes, output thread.',
    props: { package: pkg, json: bool('Return structured JSON') },
    argv: (a) => ['audio', ...opt(a.package, '--package'), ...flag(a.json, '--json')],
    readOnly: true,
  },
  clear: {
    description: 'Wipe an app\'s data. Signs the user out.',
    props: { package: str('Package name') }, required: ['package'],
    argv: (a) => ['clear', a.package],
    destructive: true,
  },
}

const tools = Object.entries(TOOLS).map(([name, t]) => ({
  name,
  description: t.description,
  inputSchema: { type: 'object', properties: t.props, required: t.required ?? [], additionalProperties: false },
  annotations: { readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive },
}))

function validate(tool, args) {
  for (const key of Object.keys(args)) if (!Object.hasOwn(tool.props, key)) throw new Error(`unknown argument ${key}`)
  for (const key of tool.required ?? []) if (args[key] === undefined) throw new Error(`${key} is required`)
  for (const [key, value] of Object.entries(args)) {
    const { type, maximum } = tool.props[key]
    if (typeof value !== type) throw new Error(`${key} must be a ${type}`)
    if (value > maximum) throw new Error(`${key} must be <= ${maximum}`)
  }
}

async function call(name, args = {}) {
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null
  if (!tool) throw new Error(`unknown tool ${name}`)
  validate(tool, args)
  if (name === 'screenshot') {
    const png = adb(['exec-out', 'screencap', '-p'], { binary: true })
    return [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }]
  }
  const out = []
  const log = console.log
  console.log = (...parts) => out.push(parts.join(' '))
  try { await main(tool.argv(args)) } finally { console.log = log }
  return [{ type: 'text', text: out.join('\n') || 'ok' }]
}

const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

async function handle({ id, method, params }) {
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion
      return { protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} }, serverInfo: { name: 'adrive', version } }
    }
    case 'ping': return {}
    case 'tools/list': return { tools }
    case 'tools/call':
      try { return { content: await call(params?.name, params?.arguments) } }
      catch (e) { return { content: [{ type: 'text', text: String(e.message).trim() }], isError: true } }
    default:
      if (id !== undefined) throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 })
  }
}

export function serve() {
  // stdout carries the protocol; stray logs go to stderr.
  console.log = (...parts) => console.error(...parts)
  let queue = Promise.resolve()
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    if (!line.trim()) return
    let message
    try { message = JSON.parse(line) } catch { return write({ id: null, error: { code: -32700, message: 'parse error' } }) }
    // One device, one action at a time.
    queue = queue.then(async () => {
      try {
        const result = await handle(message)
        if (message.id !== undefined) write({ id: message.id, result })
      } catch (e) {
        if (message.id !== undefined) write({ id: message.id, error: { code: e.code ?? -32603, message: e.message } })
      }
    })
  })
  return new Promise((resolve) => lines.on('close', () => queue.then(resolve)))
}
