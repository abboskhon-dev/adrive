#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, realpathSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const localDex = join(here, 'helper/build/classes.dex')
const remoteDex = '/data/local/tmp/adrive.dex'
const helperRun = `ANDROID_DATA=/data/local/tmp CLASSPATH=${remoteDex} app_process /system/bin Dump`
const helperSocket = 'localabstract:adrive'

const USAGE = `adrive: drive any Android app (release builds too) over adb. Device: ANDROID_SERIAL.

  ui [--all] [--windows] [--json] [--wait <query>]  visible elements: class text= desc= id= flags @centerX,centerY [bounds]
  look [--windows] [--wait <query>]  actionable elements with refs: [3] Button "Play"; act on them as @3
  tap <query|x,y|@ref> [--nth N]  tap the element matching text/desc/id (exact first, then substring)
  longpress <query|x,y|@ref>
  slide <query|@ref> <0..1>      drag a slider to a fraction of its width
  type <text>                type into the focused field
  swipe <x1> <y1> <x2> <y2> [ms]
  scroll up|down|left|right
  key back|home|enter|del|tab|<KEYCODE>
  wait <query> [seconds]     wait until an element appears (default 10 s)
  gone <query> [seconds]     wait until it disappears
  shot [file.png]            screenshot (default adrive.png in the temp folder)
  launch <package>
  stop <package>
  current                    foreground package/activity

  --package defaults to the foreground app.
  Element commands accept --windows; tap/longpress/slide accept --nth N.
  ui and look --wait <query> first wait up to 10 s for an element only the new screen has (matching
  falls back to substring, so 'Ready' also matches 'Not ready'); on a timeout they still list the screen.
  tap, longpress, slide, type, swipe, scroll and key wait up to 2 s for the screen to settle and print what
  changed (left, appeared:, gone:, changed:); --quiet skips that, --json prints it as data. type takes them before --.
  Use -- before literal arguments that begin with --.
  log [regex] [--package pkg] [--lines N]  recent logcat lines from the app's process (default 200)
  log-clear                      clear logcat, to read only what happens next
  crash [--package pkg]                    last crash / ANR stack traces
  perf [--package pkg] [--reset]           CPU by thread, memory, frame jank since last --reset
  audio [--package pkg] [--json]           the app's audio tracks: underruns, buffers, output thread
  run <steps.json|-> [--package pkg] [--trace out.perfetto-trace] [--json]
                                 run steps like [["tap","Play"],{"do":["wait","Ready"],"settle":1}]; frames, CPU, PSS per step
  open <url>                     open a deep link
  clear <pkg>                    wipe app data (signs out)
  daemon status|stop             the helper stays up 30 s after a command; stop frees the device for other tools
  mcp                            run as an MCP server over stdio
  skill install                  install the Claude Code skill to ~/.claude/skills/adrive
  version                        print the adrive version

  ADRIVE_NO_DAEMON=1 runs the helper once per command. ADRIVE_DAEMON_IDLE=<seconds> changes the 30 s.`

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


function helperHash() {
  let bytes
  try { bytes = readFileSync(localDex) } catch { throw new Error('helper missing: run ./build.sh first') }
  return createHash('md5').update(bytes).digest('hex')
}
function ensureHelper(hash = helperHash()) {
  const remote = sh(`md5sum ${remoteDex} 2>/dev/null; true`).split(' ')[0]
  if (remote !== hash) adb(['push', localDex, remoteDex])
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function forwardedPort(create = true) {
  // get-serialno fails with several devices, like the adb shell calls this forward stands in for.
  const serial = process.env.ANDROID_SERIAL || adb(['get-serialno']).trim()
  for (const line of adb(['forward', '--list']).split('\n')) {
    const [device, local, remote] = line.trim().split(/\s+/)
    if (remote === helperSocket && device === serial && /^tcp:\d+$/.test(local)) return +local.slice(4)
  }
  const port = create ? +adb(['forward', 'tcp:0', helperSocket]).trim() : 0
  return Number.isInteger(port) && port > 0 ? port : null
}
// Resolves null when nothing answers: adb closes the forward if the helper is not listening.
function ask(port, request, timeout = 15000) {
  return new Promise((resolve) => {
    let data = ''
    const socket = connect({ host: '127.0.0.1', port })
    socket.setEncoding('utf8')
    socket.setTimeout(timeout, () => socket.destroy())
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk) => { data += chunk })
    socket.on('error', () => {})
    socket.on('close', () => { try { resolve(JSON.parse(data)) } catch { resolve(null) } })
  })
}
async function daemonAsk(fields) {
  if (process.env.ADRIVE_NO_DAEMON === '1') return null
  const idle = number(process.env.ADRIVE_DAEMON_IDLE ?? 30, 'ADRIVE_DAEMON_IDLE', 1)
  const hash = helperHash()
  try {
    const port = forwardedPort()
    if (!port) return null
    const request = { hash, ...fields }
    // A timed-out swipe would be sent again through the fallback.
    const timeout = 15000 + (fields.ms ?? 0) + (fields.timeoutMs ?? 0)
    let reply = await ask(port, request, timeout)
    if (!reply || reply.error === 'stale') {
      ensureHelper(hash)
      const pid = +sh(`${helperRun} --serve ${hash} ${idle} >/dev/null 2>&1 & echo $!`).trim()
      reply = null
      // Wait on the helper, not a timer: a one-shot run while it connects would fight it for UiAutomation.
      for (let i = 1; !reply; i++) {
        await sleep(100)
        reply = await ask(port, request, timeout)
        if (reply) break
        if (i % 5 === 0 && pid > 0 && !sh(`kill -0 ${pid} 2>/dev/null && echo up; true`).includes('up')) return null
        if (i === 150) throw Object.assign(new Error('adrive helper did not start within 15 s; run adrive daemon stop'), { fatal: true })
      }
    }
    return reply?.restart ? null : reply
  } catch (e) { if (e.fatal) throw e; return null }
}

// Event count at the last daemon read; a one-shot helper's count means nothing to the daemon.
let lastSeq
// The last read, so an action reuses its target lookup as the screen before.
let recent = null
let lastRead = null
async function dump(all = false, windows = false) {
  let result = await daemonAsk({ all, windows })
  if (result?.error) throw new Error(`adrive helper failed: ${result.error}`)
  lastSeq = result?.seq
  if (!result) {
    ensureHelper()
    const out = sh(`${helperRun}${all ? ' --all' : ''}${windows ? ' --windows' : ''}`)
    try { result = JSON.parse(out) } catch { throw new Error('invalid helper JSON; rebuild with ./build.sh') }
  }
  if (result.version !== 1 || !Array.isArray(result.windows)) throw new Error('unsupported helper output; rebuild with ./build.sh')
  delete result.seq
  if (!all) recent = { windows, data: result }
  lastRead = result
  return result
}

function nodeFlags(n, keys) {
  const out = keys.filter((key) => n[key])
  if (n.checkable) out.push(n.checked ? 'checked' : 'unchecked')
  if (!n.enabled) out.push('disabled')
  return out
}
function formatNode(n) {
  const fields = [n.class.split('.').at(-1)]
  for (const key of ['text', 'desc', 'id']) if (n[key]) fields.push(`${key}=${JSON.stringify(n[key])}`)
  fields.push(...nodeFlags(n, ['clickable', 'scrollable', 'editable', 'selected']), `@${n.x},${n.y}`, `[${n.left},${n.top},${n.right},${n.bottom}]`)
  return fields.join(' ')
}

async function find(query, nth = 0, windows = false, all = false) {
  const q = required(query, 'query').toLowerCase()
  const nodes = (await dump(all, windows)).windows.flatMap((w) => w.nodes.map((n) => ({ ...n, windowId: w.id })))
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
const ACTIONABLE = (n) => n.clickable || n.longClickable || n.editable || n.scrollable || n.checkable || /SeekBar|Slider/.test(n.class)
const same = (keys) => (a, b) => keys.every((k) => a[k] === b[k])
const sameBox = same(['class', 'id', 'left', 'top', 'right', 'bottom'])
const sameNode = same(['class', 'text', 'desc', 'id', 'left', 'top', 'right', 'bottom'])
// Not in /tmp: it is shared between users on Linux.
function refsFile() {
  const serial = process.env.ANDROID_SERIAL || adb(['get-serialno']).trim()
  const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'adrive')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return join(dir, `refs-${createHash('md5').update(serial).digest('hex').slice(0, 12)}.json`)
}
function savedRefs() {
  try {
    const saved = JSON.parse(readFileSync(refsFile(), 'utf8'))
    return Array.isArray(saved?.refs) ? saved : null
  } catch { return null }
}
async function look(windows, data) {
  data ??= await dump(false, windows)
  const refs = data.windows.flatMap((w) => w.nodes.filter(ACTIONABLE).map((n) => ({ ...n, windowId: w.id })))
  writeFileSync(refsFile(), JSON.stringify({ windows, refs }))
  return refs
}
function describe(n) {
  const label = n.text || n.desc || n.id.split('/').at(-1)
  return [n.class.split('.').at(-1), ...(label ? [JSON.stringify(label)] : []),
    ...nodeFlags(n, ['editable', 'scrollable', 'selected'])].join(' ')
}
const formatRef = (n, i) => `[${i + 1}] ${describe(n)}`
async function resolveRef(ref, saved, nth, windows) {
  if (nth !== undefined) throw new Error('--nth does not apply to refs')
  if (windows !== saved.windows) throw new Error(`@${ref} is from \`adrive look${saved.windows ? ' --windows' : ''}\`; pass the same --windows, or look again`)
  const node = saved.refs[+ref - 1]
  if (!node) throw new Error(`@${ref} is not in the last look (${saved.refs.length} refs); run \`adrive look\``)
  const now = (await dump(false, windows)).windows.flatMap((w) => w.nodes)
  // An ID unique in both dumps survives a live label like "Downloading 42%".
  const byId = node.id && saved.refs.filter((n) => n.id === node.id).length === 1 ? now.filter((n) => n.id === node.id) : []
  const found = byId.length === 1 ? (sameBox(byId[0], node) ? byId[0] : null) : now.find((n) => sameNode(n, node))
  if (!found) throw new Error(`@${ref} ${formatRef(node, +ref - 1)} is gone or moved; run \`adrive look\``)
  return { ...found, line: formatNode(found) }
}
async function point(target, nth, windows) {
  required(target, 'target')
  const ref = target.match(/^@(\d+)$/)
  // Text like "@2024" is still matched as text until the first look.
  const saved = ref && savedRefs()
  if (saved) return resolveRef(ref[1], saved, nth, windows)
  const m = target.match(/^(-?\d+),(-?\d+)$/)
  if (m) return { x: number(m[1], 'x', -2147483648), y: number(m[2], 'y', -2147483648) }
  const node = await find(target, nth, windows)
  if (!node) throw new Error(ref ? `no refs yet and no element matches "${target}"; run \`adrive look\`` : `no element matches "${target}" — run \`adrive ui\``)
  return { ...node, line: formatNode(node) }
}

// --wait reuses the read it ended on; on a timeout it returns that screen and the error.
async function read(query, all, windows) {
  if (!query) return { data: await dump(all, windows) }
  try { await waitFor(query, 10, true, windows, all) } catch (e) {
    if (!lastRead || !e.message.startsWith('timed out')) throw e
    return { data: lastRead, error: e }
  }
  return { data: lastRead }
}

// `wm size` is always portrait; the display's cur= size follows rotation.
function screenSize() {
  const m = sh('dumpsys window displays').match(/\bcur=(\d+)x(\d+)/) ?? sh('wm size').match(/(\d+)x(\d+)\s*$/)
  if (!m) throw new Error('could not read the screen size from dumpsys window or wm size')
  return { w: +m[1], h: +m[2] }
}

async function waitFor(query, seconds, present, windows, all = false) {
  const end = Date.now() + seconds * 1000
  while (Date.now() < end) {
    const start = Date.now()
    if (!!(await find(query, 0, windows, all)) === present) return
    const left = end - Date.now()
    // The daemon answers when the screen changes; at most 10 reads a second on animating screens.
    const changed = lastSeq !== undefined && left > 0 && await daemonAsk({ cmd: 'change', seq: lastSeq, timeoutMs: Math.min(left, 10000) })
    await sleep(changed ? 100 - (Date.now() - start) : 300)
  }
  throw new Error(`timed out waiting for "${query}" to ${present ? 'appear' : 'disappear'}`)
}

const SETTLE_MS = 2000, QUIET_MS = 300
const ACTIONS = new Set(['tap', 'longpress', 'slide', 'type', 'swipe', 'scroll', 'key'])
const box = (n) => [n.class, n.id, n.left, n.top, n.right, n.bottom].join('|')
const nodeKey = (n) => `${box(n)}|${n.text}|${n.desc}|${!!n.checked}|${!!n.selected}`
const nodesOf = (data) => data.windows.flatMap((w) => w.nodes)
const layout = (nodes) => nodes.map(box).sort().join('\n')
// Settled: no accessibility event for QUIET_MS, or the same layout for QUIET_MS while labels animate.
async function settle(windows, start) {
  let data = await dump(false, windows), nodes = nodesOf(data), stable = Date.now()
  const flips = new Map()
  let reads = 0
  const done = (settled) => ({ data, nodes, settled, animating: new Set([...flips].filter(([, c]) => c > 1).map(([b]) => b)) })
  while (Date.now() - start < SETTLE_MS) {
    const seq = lastSeq, left = SETTLE_MS - (Date.now() - start)
    if (seq !== undefined && (await daemonAsk({ cmd: 'change', seq, timeoutMs: Math.min(QUIET_MS, left) }))?.seq === seq) return done(left >= QUIET_MS)
    if (seq === undefined) await sleep(Math.min(100, left))
    data = await dump(false, windows)
    const next = nodesOf(data), last = new Set(nodes.map(nodeKey))
    if (layout(next) !== layout(nodes)) stable = Date.now()
    for (const n of next) if (!last.has(nodeKey(n))) flips.set(box(n), (flips.get(box(n)) ?? 0) + 1)
    nodes = next
    // Two reads, so a label changing on every read is seen twice and counted as animating.
    if (++reads >= 2 && Date.now() - stable >= QUIET_MS) return done(true)
  }
  return done(false)
}
// Type -1 is the active window; with --windows the topmost can be the keyboard or status bar.
const appPackage = (data) => data.windows.find((w) => w.type === 1 || w.type === -1)?.package ?? null
function screenDiff(beforeData, { data, nodes, settled, animating }) {
  const keyed = (list) => new Map(list.map((n) => [nodeKey(n), n]))
  const was = keyed(nodesOf(beforeData)), now = keyed(nodes)
  let appeared = [...now].filter(([k]) => !was.has(k)).map(([, n]) => n)
  let gone = [...was].filter(([k]) => !now.has(k)).map(([, n]) => n)
  // A label that changed more than once while settling is an animation, not a result.
  const changed = []
  for (const to of appeared) {
    const from = gone.find((g) => box(g) === box(to))
    if (from) changed.push({ from, to })
  }
  const paired = new Set(changed.flatMap((c) => [c.from, c.to]))
  appeared = appeared.filter((n) => !paired.has(n))
  gone = gone.filter((n) => !paired.has(n))
  const from = appPackage(beforeData), to = appPackage(data)
  return { settled, ...(from !== to && { left: { from, to } }),
    appeared, gone, changed: changed.filter((c) => !animating.has(box(c.to))) }
}
// A new screen would list every node; the full lists stay in --json.
function capped(list, name, line) {
  const out = list.slice(0, 10).map((x) => `${name}: ${line(x)}`)
  if (list.length > 10) out.push(`${name}: ${list.length - 10} more`)
  return out
}
function changeTo({ from, to }) {
  const parts = from.text !== to.text || from.desc !== to.desc ? [JSON.stringify(to.text || to.desc)] : []
  if (!!from.checked !== !!to.checked) parts.push(to.checked ? 'checked' : 'unchecked')
  if (!!from.selected !== !!to.selected) parts.push(to.selected ? 'selected' : 'not selected')
  return parts.join(' ')
}
function formatDiff(d) {
  const lines = [...(d.left ? [`left ${d.left.from ?? 'no window'} -> ${d.left.to ?? 'no window'}`] : []),
    ...capped(d.appeared, 'appeared', describe), ...capped(d.gone, 'gone', describe),
    ...capped(d.changed, 'changed', (c) => `${describe(c.from)} -> ${changeTo(c)}`)]
  if (!lines.length) lines.push('no change')
  if (!d.settled) lines.push(`still changing after ${SETTLE_MS / 1000} s`)
  return lines.join('\n')
}

const KEYS = { back: 4, home: 3, enter: 66, del: 67, tab: 61 }

// One socket round trip through the daemon instead of spawning `input` on the device.
async function inject(request, ...fallback) {
  const reply = await daemonAsk(request)
  if (reply?.ok) return
  if (reply?.error && !reply.restart) throw new Error(`adrive helper failed: ${reply.error}`)
  shell('input', ...fallback)
}
const swipe = (x1, y1, x2, y2, ms) => inject({ cmd: 'swipe', x1, y1, x2, y2, ms }, 'swipe', x1, y1, x2, y2, ms)

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

const STEP_COMMANDS = new Set(['look', 'tap', 'longpress', 'slide', 'type', 'swipe', 'scroll', 'key', 'wait', 'gone', 'shot', 'launch', 'stop', 'open'])
function parseSteps(text) {
  let list
  try { list = JSON.parse(text) } catch { throw new Error('steps must be a JSON array') }
  if (!Array.isArray(list) || !list.length) throw new Error('steps must be a nonempty JSON array')
  return list.map((raw, i) => {
    const step = Array.isArray(raw) ? { do: raw } : raw
    if (!step || !Array.isArray(step.do) || !step.do.every((a) => typeof a === 'string') || !STEP_COMMANDS.has(step.do[0])) {
      throw new Error(`step ${i + 1}: expected ["command", ...args] or {"do": [...], "settle": seconds}`)
    }
    return { args: step.do, settle: number(step.settle ?? 0, `step ${i + 1} settle`, 0, false) }
  })
}

// CPU ticks per thread name, from /proc/<pid>/task/*/stat lines.
function threadTicks(text) {
  const ticks = new Map()
  for (const line of text.split('\n')) {
    const open = line.indexOf('('), close = line.lastIndexOf(')')
    if (open < 0 || close < open) continue
    const fields = line.slice(close + 2).split(' ')
    ticks.set(line.slice(0, open).trim(), { name: line.slice(open + 1, close), ticks: +fields[11] + +fields[12] })
  }
  return ticks
}
// Stats before the gfxinfo reset close the previous step; stats after it open the next one.
function sample(pkg) {
  // Threads can exit between the glob and the read.
  const stat = 'cat /proc/$p/task/*/stat 2>/dev/null; true'
  const out = adb(['shell', `p=$(pidof ${quote(pkg)} | cut -d' ' -f1); echo "pid $p"; [ -n "$p" ] || exit 0; ${stat}; echo ---; `
    + `dumpsys meminfo $p | grep -E 'TOTAL PSS:|^ +TOTAL '; echo ---; dumpsys gfxinfo ${quote(pkg)} reset; echo ---; ${stat}`], { timeout: 45000 })
  const [head, mem = '', gfx = '', next = ''] = out.split(/^---$/m)
  const pid = Number(head.match(/^pid (\d+)/m)?.[1]) || null
  const total = gfx.match(/Total frames rendered: (\d+)/)
  // With no frames, gfxinfo reports its largest bucket as every percentile.
  const num = (re) => { const m = total && +total[1] && gfx.match(re); return m ? +m[1] : null }
  return { pid, end: threadTicks(head), start: threadTicks(next),
    pss: Number(mem.match(/TOTAL PSS:\s+(\d+)/)?.[1] ?? mem.match(/^\s*TOTAL\s+(\d+)/m)?.[1]) || null,
    frames: { total: total ? +total[1] : null, janky: num(/Janky frames: (\d+)/) ?? (total ? 0 : null),
      p50: num(/50th percentile: (\d+)ms/), p90: num(/90th percentile: (\d+)ms/), p99: num(/99th percentile: (\d+)ms/) } }
}
function measure(before, after) {
  if (!before.pid || before.pid !== after.pid) return { cpuMs: null, threads: [] }
  const byName = new Map()
  for (const [tid, t] of after.end) {
    const ms = (t.ticks - (before.start.get(tid)?.ticks ?? 0)) * 10
    if (ms > 0) byName.set(t.name, (byName.get(t.name) ?? 0) + ms)
  }
  const threads = [...byName].map(([name, ms]) => ({ name, ms })).sort((a, b) => b.ms - a.ms)
  return { cpuMs: threads.reduce((sum, t) => sum + t.ms, 0), threads }
}

const PERFETTO_OUT = '/data/misc/perfetto-traces/adrive.perfetto-trace'
function startTrace(pkg) {
  const pid = sh(`perfetto --background -o ${PERFETTO_OUT} -t 600s -b 64mb --app ${quote(pkg)} sched freq idle am wm gfx view input dalvik binder_driver 2>&1`).trim()
  if (!/^\d+$/.test(pid)) throw new Error(`perfetto failed to start: ${pid}`)
  return pid
}
async function stopTrace(pid, file) {
  sh(`kill -TERM ${pid}`)
  // perfetto writes the trace only after it exits, which can take seconds.
  for (let i = 0; sh(`kill -0 ${pid} 2>/dev/null && echo up; true`).includes('up'); i++) {
    if (i === 120) throw new Error(`perfetto did not finish within 60 s; the trace is at ${PERFETTO_OUT}`)
    await sleep(500)
  }
  adb(['pull', PERFETTO_OUT, file], { timeout: 60000 })
  sh(`rm -f ${PERFETTO_OUT}`)
  if (!statSync(file).size) throw new Error('perfetto wrote an empty trace')
}

const label = (args) => args.map((a) => /^[\w.,:/-]+$/.test(a) ? a : JSON.stringify(a)).join(' ')
function formatStep(s) {
  const f = s.frames, lines = [`${s.step} ${label(s.args)}  ${(s.ms / 1000).toFixed(2)} s${s.error ? `  FAILED: ${s.error}` : ''}`]
  lines.push(f.total === null ? '  frames: none reported' : !f.total ? '  frames 0'
    : `  frames ${f.total}, janky ${f.janky}, p50 ${f.p50} ms, p90 ${f.p90} ms, p99 ${f.p99} ms`)
  if (s.cpuMs !== null) {
    const top = s.threads.slice(0, 4).map((t) => `${t.name} ${t.ms}`).join(', ')
    lines.push(`  cpu ${s.cpuMs} ms (${Math.round(s.cpuMs / s.ms * 100)}%)${top ? `: ${top}` : ''}`)
  } else lines.push('  cpu: app not running for the whole step')
  if (s.pssKb !== null) lines.push(`  pss ${(s.pssKb / 1024).toFixed(1)} MB${s.pssDeltaKb === null ? '' : ` (${s.pssDeltaKb >= 0 ? '+' : ''}${(s.pssDeltaKb / 1024).toFixed(1)})`}`)
  return lines.join('\n')
}

// Settle reads would add accessibility work to the app's measured CPU and frames.
let measuring = false
async function runSteps(steps, pkg, trace, json) {
  const tracer = trace && startTrace(pkg)
  measuring = true
  const results = []
  let failure
  // Whatever fails, the trace is stopped and the steps measured so far are reported.
  try {
    let before = sample(pkg)
    for (const [i, step] of steps.entries()) {
      const start = Date.now(), output = [], print = console.log
      let error
      console.log = (...a) => output.push(a.join(' '))
      try { await main(step.args) } catch (e) { error = e } finally { console.log = print }
      await sleep(step.settle * 1000)
      const ms = Date.now() - start
      const after = sample(pkg)
      results.push({ step: i + 1, args: step.args, ms, ...measure(before, after), frames: after.frames, pssKb: after.pss,
        pssDeltaKb: after.pss && before.pss ? after.pss - before.pss : null, output: output.join('\n'), ...(error && { error: error.message }) })
      if (!json) console.log(formatStep(results.at(-1)))
      before = after
      if (error) { failure = new Error(`step ${i + 1} failed: ${error.message}`); break }
    }
  } catch (e) { failure = e }
  measuring = false
  if (tracer) {
    try { await stopTrace(tracer, trace) } catch (e) {
      failure = new Error(failure ? `${failure.message}; ${e.message}` : e.message)
      trace = null
    }
  }
  if (json) console.log(JSON.stringify({ package: pkg, steps: results, ...(trace && { trace }) }))
  else if (trace) console.log(`trace: ${trace}`)
  if (failure) throw failure
}

// AudioFlinger column titles that span two whitespace-separated words.
const SPLIT_TITLES = new Set(['Port Id', 'Chn mask', 'G db', 'L dB', 'R dB', 'VS dB', 'L Vol', 'R Vol'])
function columns(header) {
  const out = []
  for (const word of header.trim().split(/\s+/)) {
    if (out.length && SPLIT_TITLES.has(`${out.at(-1)} ${word}`)) out[out.length - 1] += ` ${word}`
    else out.push(word)
  }
  return out
}
// Rows omit Type for normal tracks, so columns are aligned on the Active yes/no cell.
function trackRow(line, cols) {
  const words = line.trim().split(/\s+/)
  const active = words.findIndex((w) => w === 'yes' || w === 'no')
  const at = cols.indexOf('Active')
  if (active < 1 || at < 1) return null
  const cell = (name) => words[active + cols.indexOf(name) - at]
  const num = (name) => { const v = Number(cell(name)); return Number.isFinite(v) ? v : null }
  return { id: num('Id'), active: cell('Active') === 'yes', client: num('Client'), state: cell('S'),
    flags: cell('Flags'), rate: num('SRate'), frames: num('FrmCnt'), underruns: num('Underruns') }
}
function parseAudio(dump, pids) {
  const threads = []
  for (const block of dump.split(/^(?=\S.* thread 0x[0-9a-f]+, name )/m)) {
    const head = block.match(/^(\S+) thread 0x[0-9a-f]+, name (\S+), tid \d+, type \d+ \((\w+)\)/)
    if (!head) continue
    const field = (re) => block.match(re)?.[1]
    const header = block.split('\n').find((l) => /\bActive\b/.test(l) && /\bUnderruns\b/.test(l))
    const cols = header ? columns(header) : []
    const tracks = [], history = new Map()
    let inLog = false
    for (const line of block.split('\n')) {
      if (/^\s*Local log:/.test(line)) { inLog = true; continue }
      if (!cols.length || line === header) continue
      const event = inLog && line.match(/^\s*(\d\d-\d\d \S+) (\S+)/)
      if (inLog && !event) continue
      const row = trackRow(event ? line.slice(line.indexOf(')') + 1) : line, cols)
      if (!row || row.id === null || !pids.includes(row.client)) continue
      if (event) history.set(row.id, { ...row, time: event[1], event: event[2] })
      else tracks.push(row)
    }
    if (!tracks.length && !history.size) continue
    const mixer = block.match(/raw underrun counters: partial=(\d+) empty=(\d+)/)
    threads.push({ direction: head[1], name: head[2], type: head[3],
      output: field(/AudioStreamOut: \S+ flags \S+ \(([^)]*)\)/)?.replace(/AUDIO_OUTPUT_FLAG_/g, '') ?? '',
      standby: field(/Standby: (\w+)/) === 'yes', rate: Number(field(/Sample rate: (\d+)/)) || null,
      halFrames: Number(field(/HAL frame count: (\d+)/)) || null,
      delayedWrites: Number(field(/Delayed writes: (\d+)/) ?? 0),
      mixerUnderruns: mixer ? { partial: +mixer[1], empty: +mixer[2] } : null,
      tracks, history: [...history.values()] })
  }
  return threads
}
function formatAudio(pkg, pids, threads) {
  const ms = (t) => t.rate && t.underruns ? ` (${(t.underruns / t.rate * 1000).toFixed(1)} ms)` : ''
  const track = (t) => `track ${t.id} ${t.active ? 'active' : 'idle'} ${t.rate} Hz, buffer ${t.frames} frames, flags ${t.flags}, underrun frames ${t.underruns}${ms(t)}`
  const lines = [`${pkg} pid ${pids.join(',')}`]
  if (!threads.length) lines.push('no audio tracks from this process')
  for (const th of threads) {
    lines.push(`${th.name} ${th.type}${th.output ? ` (${th.output})` : ''} ${th.rate} Hz, HAL ${th.halFrames} frames${th.standby ? ', standby' : ''}`
      + `, delayed writes ${th.delayedWrites}${th.mixerUnderruns ? `, mixer underruns partial=${th.mixerUnderruns.partial} empty=${th.mixerUnderruns.empty}` : ''}`)
    for (const t of th.tracks) lines.push(`  ${track(t)}`)
    const glitched = th.history.filter((t) => t.underruns > 0 && !th.tracks.some((c) => c.id === t.id))
    if (th.history.length) lines.push(`  history: ${th.history.length} recent tracks, ${glitched.length} closed with underruns`)
    for (const t of glitched) lines.push(`    ${t.time} ${track(t)}`)
  }
  return lines.join('\n')
}

const nthFlag = (flags) => flags['--nth'] === undefined ? undefined : number(flags['--nth'], '--nth')
// Returns the line to print, or null.
async function act(cmd, args, nth, windows, ready = async () => {}) {
  switch (cmd) {
    case 'tap':
    case 'longpress': {
      const p = await point(args.join(' '), nth, windows)
      await ready()
      if (cmd === 'tap') await inject({ cmd: 'tap', x: p.x, y: p.y }, 'tap', p.x, p.y)
      else await swipe(p.x, p.y, p.x, p.y, 800)
      return `${cmd === 'tap' ? 'tapped' : 'long-pressed'} ${p.line ?? `${p.x},${p.y}`}`
    }
    case 'slide': {
      arity(args, 2, Infinity, 'slide <query|@ref> <0..1>')
      const fraction = number(args.pop(), 'fraction', 0, false)
      if (fraction > 1) throw new Error('fraction must be <= 1')
      const node = await point(args.join(' '), nth, windows)
      if (!node.line || node.right <= node.left) throw new Error('slide requires an element with nonempty bounds')
      const pad = Math.min(24, (node.right - node.left) / 20)
      const from = Math.round(fraction < 0.5 ? node.right - pad : node.left + pad)
      const to = Math.round(node.left + pad + (node.right - node.left - 2 * pad) * fraction)
      await ready()
      await swipe(from, node.y, to, node.y, 700)
      return `slid to ${fraction} ${node.line}`
    }
    case 'type': {
      arity(args, 1, Infinity, 'type <text>')
      const text = args.join(' ')
      // Android input text only reliably supports printable ASCII key events.
      if (/[^\x20-\x7e]/.test(text)) throw new Error('type supports printable ASCII only; Unicode/newlines require an IME')
      // Isolate every literal percent: Android converts %s to a space per invocation.
      const chunks = text.split(/(%)/).filter(Boolean)
      await ready()
      for (const chunk of chunks) shell('input', 'text', chunk.replace(/ /g, '%s'))
      return null
    }
    case 'swipe': {
      arity(args, 4, 5, 'swipe <x1> <y1> <x2> <y2> [ms]')
      const coords = args.slice(0, 4).map((v) => number(v, 'coordinate', -2147483648))
      const ms = number(args[4] ?? 300, 'duration', 1)
      await ready()
      await swipe(...coords, ms)
      return null
    }
    case 'scroll': {
      arity(args, 1, 1, 'scroll up|down|left|right')
      if (!['up', 'down', 'left', 'right'].includes(args[0])) throw new Error('scroll up|down|left|right')
      const { w, h } = screenSize()
      const [cx, cy, dx, dy] = [w / 2, h / 2, w * 0.3, h * 0.3].map(Math.round)
      const v = { down: [cx, cy + dy, cx, cy - dy], up: [cx, cy - dy, cx, cy + dy], right: [cx + dx, cy, cx - dx, cy], left: [cx - dx, cy, cx + dx, cy] }[args[0]]
      await ready()
      await swipe(...v, 300)
      return null
    }
    case 'key': {
      arity(args, 1, 1, 'key <name|KEYCODE|number>')
      const key = Object.hasOwn(KEYS, args[0]) ? KEYS[args[0]] : args[0]
      if (!/^KEYCODE_[A-Z0-9_]+$/.test(key)) number(key, 'keycode')
      await ready()
      await inject({ cmd: 'key', key: String(key) }, 'keyevent', key)
      return null
    }
  }
}

async function main([cmd, ...raw]) {
  const element = ['tap', 'longpress', 'slide', 'wait', 'gone'].includes(cmd)
  const allowed = element ? { '--windows': false } : {}
  if (['tap', 'longpress', 'slide'].includes(cmd)) allowed['--nth'] = true
  if (cmd === 'look') Object.assign(allowed, { '--windows': false, '--wait': true })
  if (cmd === 'ui') Object.assign(allowed, { '--all': false, '--windows': false, '--json': false, '--wait': true })
  if (['log', 'crash', 'perf', 'audio'].includes(cmd)) allowed['--package'] = true
  if (cmd === 'audio') allowed['--json'] = false
  if (cmd === 'log') allowed['--lines'] = true
  if (cmd === 'perf') allowed['--reset'] = false
  if (cmd === 'run') Object.assign(allowed, { '--package': true, '--trace': true, '--json': false })
  if (ACTIONS.has(cmd)) Object.assign(allowed, { '--quiet': false, '--json': false })
  // Text is literal, including --nth; options go before an explicit --.
  const cut = raw.indexOf('--'), lead = raw.slice(0, Math.max(cut, 0))
  const { args, flags } = cmd !== 'type' ? options(raw, allowed)
    : cut >= 0 && lead.every((a) => Object.hasOwn(allowed, a)) ? { args: raw.slice(cut + 1), flags: options(lead, allowed).flags }
    : { args: raw, flags: {} }
  if (ACTIONS.has(cmd)) {
    if (flags['--quiet'] && flags['--json']) throw new Error('--quiet and --json cannot be combined')
    if (flags['--quiet'] || measuring) {
      const line = await act(cmd, args, nthFlag(flags), !!flags['--windows'])
      return line && console.log(line)
    }
    const windows = !!flags['--windows']
    let before, start
    recent = null
    const line = await act(cmd, args, nthFlag(flags), windows, async () => {
      before = recent?.windows === windows ? recent.data : await dump(false, windows)
      start = Date.now()
    })
    const d = screenDiff(before, await settle(windows, start))
    if (flags['--json']) return console.log(JSON.stringify({ ...(line && { done: line }), ...d }))
    if (line) console.log(line)
    return console.log(formatDiff(d))
  }
  const windows = !!flags['--windows']
  switch (cmd) {
    case 'ui': {
      arity(args, 0, 0, 'ui [--all] [--windows] [--json] [--wait <query>]')
      const { data, error } = await read(flags['--wait'], !!flags['--all'], windows)
      if (flags['--json']) console.log(JSON.stringify(data))
      else if (!data.windows.length && !error) throw new Error('no accessible window; is the screen on and unlocked?')
      else for (const w of data.windows) {
        console.log(`package=${w.package} window=${w.id} type=${w.type} layer=${w.layer}`)
        for (const n of w.nodes) console.log(formatNode(n))
      }
      if (error) throw error
      return
    }
    case 'look': {
      arity(args, 0, 0, 'look [--windows] [--wait <query>]')
      const { data, error } = await read(flags['--wait'], false, windows)
      const refs = await look(windows, data)
      if (!refs.length && !error) throw new Error('no actionable elements; is the screen on and unlocked? try `adrive ui`')
      if (refs.length) console.log(refs.map(formatRef).join('\n'))
      if (error) throw error
      return
    }
    case 'wait':
    case 'gone':
      arity(args, 1, 2, `${cmd} <query> [seconds]`)
      return waitFor(required(args[0], 'query'), number(args[1] ?? 10, 'seconds', 0.001, false), cmd === 'wait', windows)
    case 'shot': {
      arity(args, 0, 1, 'shot [file.png]')
      const file = args[0] ?? join(tmpdir(), 'adrive.png')
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
    case 'audio': {
      arity(args, 0, 0, 'audio [--package pkg] [--json]')
      const pkg = pkgArg(flags['--package'])
      const pids = sh(`pidof ${quote(pkg)}; true`).trim().split(/\s+/).filter((p) => /^\d+$/.test(p)).map(Number)
      if (!pids.length) throw new Error(`${pkg} is not running`)
      const threads = parseAudio(shell('dumpsys', 'media.audio_flinger'), pids)
      if (flags['--json']) return console.log(JSON.stringify({ package: pkg, pids, threads }))
      return console.log(formatAudio(pkg, pids, threads))
    }
    case 'run': {
      arity(args, 1, 1, 'run <steps.json|-> [--package pkg] [--trace out.perfetto-trace] [--json]')
      const steps = parseSteps(readFileSync(args[0] === '-' ? 0 : args[0], 'utf8'))
      return runSteps(steps, pkgArg(flags['--package']), flags['--trace'], !!flags['--json'])
    }
    case 'open':
      arity(args, 1, 1, 'open <url>')
      return shell('am', 'start', '-a', 'android.intent.action.VIEW', '-d', required(args[0], 'url'))
    case 'daemon': {
      arity(args, 1, 1, 'daemon status|stop')
      if (!['status', 'stop'].includes(args[0])) throw new Error('usage: adrive daemon status|stop')
      const port = forwardedPort(false)
      const reply = port && await ask(port, { cmd: args[0] })
      if (port && args[0] === 'stop') adb(['forward', '--remove', `tcp:${port}`])
      if (!reply?.ok) return console.log('not running')
      return console.log(args[0] === 'stop' ? 'stopped' : `running (pid ${reply.pid}, exits after ${reply.idleSeconds} s idle)`)
    }
    case 'mcp':
      arity(args, 0, 0, 'mcp')
      return (await import('./mcp.mjs')).serve()
    case 'skill': {
      arity(args, 1, 1, 'skill install')
      if (args[0] !== 'install') throw new Error('usage: adrive skill install')
      const dest = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills/adrive')
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'SKILL.md'), readFileSync(join(here, 'skill/SKILL.md')))
      return console.log(`installed ${join(dest, 'SKILL.md')}`)
    }
    case 'version':
    case '--version':
      arity(args, 0, 0, 'version')
      console.log(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version)
      try { return console.log(`helper sha256 ${createHash('sha256').update(readFileSync(localDex)).digest('hex')}`) } catch { return console.log('helper not built') }
    case undefined:
    case 'help':
    case '--help':
      return console.log(USAGE)
    default:
      throw new Error(`unknown command ${cmd}; run adrive help`)
  }
}

export { main, adb, quote, formatNode, parseAudio, parseSteps, runSteps, pkgArg }
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(String(e.message).trim())
    process.exitCode = 1
  })
}
