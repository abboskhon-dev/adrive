#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const localDex = join(here, 'helper/build/classes.dex')
const remoteDex = '/data/local/tmp/adrive.dex'

const USAGE = `adrive: drive any Android app (release builds too) over adb. Device: ANDROID_SERIAL.

  ui [--all] [--windows] [--json]                 visible elements: class text= desc= id= flags @centerX,centerY [bounds]
  tap <query|x,y> [--nth N]  tap the element matching text/desc/id (exact first, then substring)
  longpress <query|x,y>
  slide <query> <0..1>       drag a slider to a fraction of its width
  type <text>                type into the focused field
  swipe <x1> <y1> <x2> <y2> [ms]
  scroll up|down|left|right
  key back|home|enter|del|tab|<KEYCODE>
  wait <query> [seconds]     wait until an element appears (default 10 s)
  gone <query> [seconds]     wait until it disappears
  shot [file.png]            screenshot (default /tmp/adrive.png)
  launch <package>
  stop <package>
  current                    foreground package/activity

  --package defaults to the foreground app.
  Element commands accept --windows; tap/longpress/slide accept --nth N.
  Use -- before literal arguments that begin with --.
  log [regex] [--package pkg] [--lines N]  recent logcat lines from the app's process (default 200)
  log-clear                      clear logcat, to read only what happens next
  crash [--package pkg]                    last crash / ANR stack traces
  perf [--package pkg] [--reset]           CPU by thread, memory, frame jank since last --reset
  open <url>                     open a deep link
  clear <pkg>                    wipe app data (signs out)`

const adb = (args, opts = {}) =>
  execFileSync('adb', args, { encoding: opts.binary ? 'buffer' : 'utf8', timeout: opts.timeout ?? 15000, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] })
const sh = (cmd) => adb(['shell', cmd])
const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'"
const shell = (...args) => sh(args.map(quote).join(' '))

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value
}
function number(value, name, min = 0, integer = true) {
  if (value === undefined || String(value).trim() === '' || !Number.isFinite(+value)
      || +value < min || (integer && !Number.isSafeInteger(+value))) {
    throw new Error(`${name} must be a ${integer ? 'safe integer' : 'finite number'} >= ${min}`)
  }
  return +value
}
function packageName(value) {
  required(value, 'package')
  if (!/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/.test(value)) throw new Error('invalid package name')
  return value
}
function options(args, allowed) {
  const positional = [], flags = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { positional.push(...args.slice(i + 1)); break }
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    if (!Object.hasOwn(allowed, arg)) throw new Error(`unknown option ${arg}; use -- for literal text`)
    if (Object.hasOwn(flags, arg)) throw new Error(`duplicate option ${arg}`)
    flags[arg] = allowed[arg] ? required(args[++i], arg) : true
  }
  return { args: positional, flags }
}
function arity(args, min, max, usage) {
  if (args.length < min || args.length > max) throw new Error(`usage: adrive ${usage}`)
}


function ensureHelper() {
  let bytes
  try { bytes = readFileSync(localDex) } catch { throw new Error('helper missing: run ./build.sh first') }
  const hash = createHash('md5').update(bytes).digest('hex')
  const remote = sh(`md5sum ${remoteDex} 2>/dev/null; true`).split(' ')[0]
  if (remote !== hash) adb(['push', localDex, remoteDex])
}

function dump(all = false, windows = false) {
  ensureHelper()
  const out = sh(`ANDROID_DATA=/data/local/tmp CLASSPATH=${remoteDex} app_process /system/bin Dump${all ? ' --all' : ''}${windows ? ' --windows' : ''}`)
  let result
  try { result = JSON.parse(out) } catch { throw new Error('invalid helper JSON; rebuild with ./build.sh') }
  if (result.version !== 1 || !Array.isArray(result.windows)) throw new Error('unsupported helper output; rebuild with ./build.sh')
  return result
}

function formatNode(n) {
  const fields = [n.class.split('.').at(-1)]
  for (const key of ['text', 'desc', 'id']) if (n[key]) fields.push(`${key}=${JSON.stringify(n[key])}`)
  for (const key of ['clickable', 'scrollable', 'editable', 'selected']) if (n[key]) fields.push(key)
  if (n.checkable) fields.push(n.checked ? 'checked' : 'unchecked')
  if (!n.enabled) fields.push('disabled')
  fields.push(`@${n.x},${n.y}`, `[${n.left},${n.top},${n.right},${n.bottom}]`)
  return fields.join(' ')
}

function find(query, nth = 0, windows = false) {
  const q = required(query, 'query').toLowerCase()
  const nodes = dump(false, windows).windows.flatMap((w) => w.nodes.map((n) => ({ ...n, windowId: w.id })))
  const keys = (n) => [n.text, n.desc, n.id, n.id.split('/').at(-1)].map((s) => s.toLowerCase())
  let hits = nodes.filter((n) => keys(n).includes(q))
  if (!hits.length) hits = nodes.filter((n) => keys(n).some((k) => k.includes(q)))
  // Preserve window Z-order; prefer clickable matches within each window.
  const order = new Map(dumpWindowOrder(nodes))
  hits.sort((a, b) => order.get(a.windowId) - order.get(b.windowId) || Number(b.clickable) - Number(a.clickable))
  return hits[nth]
}
function dumpWindowOrder(nodes) {
  return [...new Set(nodes.map((n) => n.windowId))].map((id, i) => [id, i])
}
function point(target, nth, windows) {
  required(target, 'target')
  const m = target.match(/^(-?\d+),(-?\d+)$/)
  if (m) return { x: number(m[1], 'x', -2147483648), y: number(m[2], 'y', -2147483648) }
  const node = find(target, nth, windows)
  if (!node) throw new Error(`no element matches "${target}" — run \`adrive ui\``)
  return { ...node, line: formatNode(node) }
}

function screenSize() {
  const [w, h] = sh('wm size').match(/(\d+)x(\d+)\s*$/).slice(1).map(Number)
  return { w, h }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(query, seconds, present, windows) {
  const end = Date.now() + seconds * 1000
  while (Date.now() < end) {
    if (!!find(query, 0, windows) === present) return
    await sleep(300)
  }
  throw new Error(`timed out waiting for "${query}" to ${present ? 'appear' : 'disappear'}`)
}

const KEYS = { back: 4, home: 3, enter: 66, del: 67, tab: 61 }

function foreground() {
  const focus = shell('dumpsys', 'window').match(/mCurrentFocus=Window\{[^\n}]*\s([A-Za-z_][\w.]*)\/([^\s}]+)}/)
  if (!focus) throw new Error('no focused app; specify --package <package> for diagnostics')
  return `${packageName(focus[1])}/${focus[2]}`
}
const pkgArg = (arg) => packageName(arg ?? foreground().split('/')[0])

function pid(pkg) {
  const p = sh(`pidof ${quote(pkg)}; true`).trim().split(/\s+/)[0]
  if (!/^\d+$/.test(p)) throw new Error(`${pkg} is not running`)
  return p
}
function log(pkg, pattern, lines) {
  const regex = pattern ? new RegExp(pattern, 'i') : null
  let out = adb(['logcat', '-d', '-v', 'time', `--pid=${pid(pkg)}`]).split('\n')
  if (regex) out = out.filter((l) => regex.test(l))
  return out.filter(Boolean).slice(-lines).join('\n')
}
function crash(pkg) {
  const crashes = adb(['logcat', '-d', '-b', 'crash', '-v', 'threadtime'])
    .split(/(?=^\S+ \S+ +\d+ +\d+ E AndroidRuntime: FATAL EXCEPTION)/m)
    .filter((c) => {
      const process = c.match(/ E AndroidRuntime: Process: ([^,\s]+), PID: \d+/)?.[1]
      return process === pkg || process?.startsWith(`${pkg}:`)
    })
  const anr = sh(`dumpsys activity processes ${quote(pkg)} | grep -iA3 "notResponding\\|crashing"; true`).trim()
  return [crashes.at(-1)?.trim() || `no Java crash for ${pkg} in the crash buffer`, anr && `ANR/crash state:\n${anr}`]
    .filter(Boolean).join('\n\n')
}

function perf(pkg) {
  const p = pid(pkg)
  const threads = sh(`top -H -b -n 1 -p ${p} -s 2 -o TID,%CPU,CMD | sed -n '/TID/,$p' | head -16`).trim()
  const mem = sh(`dumpsys meminfo ${quote(pkg)} | grep -E "TOTAL PSS|Native Heap|Java Heap|Graphics"; true`).trim()
  const frames = sh(`dumpsys gfxinfo ${quote(pkg)} | grep -E "Total frames|Janky frames|50th|90th|99th"; true`).trim()
  return `CPU by thread (pid ${p}):\n${threads}\n\nMemory:\n${mem}\n\nFrames:\n${frames || 'no frames rendered'}`
}

async function main([cmd, ...raw]) {
  const element = ['tap', 'longpress', 'slide', 'wait', 'gone'].includes(cmd)
  const allowed = element ? { '--windows': false } : {}
  if (['tap', 'longpress', 'slide'].includes(cmd)) allowed['--nth'] = true
  if (cmd === 'ui') Object.assign(allowed, { '--all': false, '--windows': false, '--json': false })
  if (['log', 'crash', 'perf'].includes(cmd)) allowed['--package'] = true
  if (cmd === 'log') allowed['--lines'] = true
  if (cmd === 'perf') allowed['--reset'] = false
  // Text is literal, including --nth. An initial -- is an optional delimiter.
  const { args, flags } = cmd === 'type'
    ? { args: raw[0] === '--' ? raw.slice(1) : raw, flags: {} }
    : options(raw, allowed)
  const nth = number(flags['--nth'] ?? 0, '--nth')
  const windows = !!flags['--windows']
  switch (cmd) {
    case 'ui': {
      arity(args, 0, 0, 'ui [--all] [--windows] [--json]')
      const data = dump(!!flags['--all'], windows)
      if (flags['--json']) return console.log(JSON.stringify(data))
      for (const w of data.windows) {
        console.log(`package=${w.package} window=${w.id} type=${w.type} layer=${w.layer}`)
        for (const n of w.nodes) console.log(formatNode(n))
      }
      return
    }
    case 'tap':
    case 'longpress': {
      const p = point(args.join(' '), nth, windows)
      if (cmd === 'tap') shell('input', 'tap', p.x, p.y)
      else shell('input', 'swipe', p.x, p.y, p.x, p.y, 800)
      return console.log(`${cmd === 'tap' ? 'tapped' : 'long-pressed'} ${p.line ?? `${p.x},${p.y}`}`)
    }
    case 'slide': {
      arity(args, 2, Infinity, 'slide <query> <0..1>')
      const fraction = number(args.pop(), 'fraction', 0, false)
      if (fraction > 1) throw new Error('fraction must be <= 1')
      const node = point(args.join(' '), nth, windows)
      if (!node.line || node.right <= node.left) throw new Error('slide requires an element with nonempty bounds')
      const pad = Math.min(24, (node.right - node.left) / 20)
      const from = Math.round(fraction < 0.5 ? node.right - pad : node.left + pad)
      const to = Math.round(node.left + pad + (node.right - node.left - 2 * pad) * fraction)
      shell('input', 'swipe', from, node.y, to, node.y, 700)
      return console.log(`slid to ${fraction} ${node.line}`)
    }
    case 'type': {
      arity(args, 1, Infinity, 'type <text>')
      const text = args.join(' ')
      // Android input text only reliably supports printable ASCII key events.
      if (/[^\x20-\x7e]/.test(text)) throw new Error('type supports printable ASCII only; Unicode/newlines require an IME')
      // Isolate every literal percent: Android converts %s to a space per invocation.
      const chunks = text.split(/(%)/).filter(Boolean)
      for (const chunk of chunks) shell('input', 'text', chunk.replace(/ /g, '%s'))
      return
    }
    case 'swipe': {
      arity(args, 4, 5, 'swipe <x1> <y1> <x2> <y2> [ms]')
      const coords = args.slice(0, 4).map((v) => number(v, 'coordinate', -2147483648))
      return shell('input', 'swipe', ...coords, number(args[4] ?? 300, 'duration', 1))
    }
    case 'scroll': {
      arity(args, 1, 1, 'scroll up|down|left|right')
      if (!['up', 'down', 'left', 'right'].includes(args[0])) throw new Error('scroll up|down|left|right')
      const { w, h } = screenSize()
      const [cx, cy, dx, dy] = [w / 2, h / 2, w * 0.3, h * 0.3].map(Math.round)
      const v = { down: [cx, cy + dy, cx, cy - dy], up: [cx, cy - dy, cx, cy + dy], right: [cx + dx, cy, cx - dx, cy], left: [cx - dx, cy, cx + dx, cy] }[args[0]]
      return shell('input', 'swipe', ...v, 300)
    }
    case 'key': {
      arity(args, 1, 1, 'key <name|KEYCODE|number>')
      const key = Object.hasOwn(KEYS, args[0]) ? KEYS[args[0]] : args[0]
      if (!/^KEYCODE_[A-Z0-9_]+$/.test(key)) number(key, 'keycode')
      return shell('input', 'keyevent', key)
    }
    case 'wait':
    case 'gone':
      arity(args, 1, 2, `${cmd} <query> [seconds]`)
      return waitFor(required(args[0], 'query'), number(args[1] ?? 10, 'seconds', 0.001, false), cmd === 'wait', windows)
    case 'shot': {
      arity(args, 0, 1, 'shot [file.png]')
      const file = args[0] ?? '/tmp/adrive.png'
      writeFileSync(file, adb(['exec-out', 'screencap', '-p'], { binary: true }))
      return console.log(file)
    }
    case 'launch':
    case 'stop':
    case 'clear': {
      arity(args, 1, 1, `${cmd} <package>`)
      const pkg = packageName(args[0])
      if (cmd === 'launch') return shell('monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', 1)
      if (cmd === 'stop') return shell('am', 'force-stop', pkg)
      return shell('pm', 'clear', pkg)
    }
    case 'current':
      arity(args, 0, 0, 'current')
      return console.log(foreground())
    case 'log': {
      arity(args, 0, 1, 'log [regex] [--package pkg] [--lines N]')
      const lines = number(flags['--lines'] ?? 200, '--lines', 1)
      if (args[0]) new RegExp(args[0], 'i')
      return console.log(log(pkgArg(flags['--package']), args[0], lines))
    }
    case 'log-clear':
      arity(args, 0, 0, 'log-clear')
      return adb(['logcat', '-c'])
    case 'crash':
    case 'perf': {
      arity(args, 0, 0, `${cmd} [--package pkg]${cmd === 'perf' ? ' [--reset]' : ''}`)
      const pkg = pkgArg(flags['--package'])
      if (cmd === 'crash') return console.log(crash(pkg))
      if (flags['--reset']) return shell('dumpsys', 'gfxinfo', pkg, 'reset')
      return console.log(perf(pkg))
    }
    case 'open':
      arity(args, 1, 1, 'open <url>')
      return shell('am', 'start', '-a', 'android.intent.action.VIEW', '-d', required(args[0], 'url'))
    case undefined:
    case 'help':
    case '--help':
      return console.log(USAGE)
    default:
      throw new Error(`unknown command ${cmd}; run adrive help`)
  }
}

export { main, quote, formatNode }
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(String(e.message).trim())
    process.exitCode = 1
  })
}
