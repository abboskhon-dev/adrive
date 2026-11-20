#!/usr/bin/env node
// Success rate and time to read the UI tree of an app that never goes idle, per tool.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const adrive = join(here, '../adrive.mjs')
const apk = join(here, 'fixture/build/fixture.apk')
const serial = process.env.ANDROID_SERIAL
const appiumUrl = process.env.APPIUM_URL?.replace(/\/$/, '')
const RUNS = Number(process.env.BENCH_RUNS ?? 20)
const TIMEOUT = 60000
const PKG = 'dev.adrive.fixture'
const NEEDLE = 'Mute Bass'
const DRIVERS = ['dev.mobile.maestro', 'dev.mobile.maestro.test', 'io.appium.uiautomator2.server', 'io.appium.uiautomator2.server.test']

if (!serial) { console.error('set ANDROID_SERIAL'); process.exit(1) }

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: TIMEOUT, maxBuffer: 64 << 20, env: { ...process.env, ...env } })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`
}
const adb = (...args) => run('adb', ['-s', serial, ...args])
const has = (cmd) => spawnSync('which', [cmd]).status === 0

// Each of these tools holds the device's single UiAutomation session, so none may outlive its turn.
function reset() {
  run(adrive, ['daemon', 'stop'])
  for (const pkg of DRIVERS) adb('shell', 'am', 'force-stop', pkg)
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`)
  for (let i = 0; i < 20; i++) {
    if (new RegExp(`mCurrentFocus=.* ${PKG}/`).test(adb('shell', 'dumpsys', 'window'))) return
    spawnSync('sleep', ['0.5'])
  }
  throw new Error(`${PKG} is not in the foreground`)
}

async function wd(method, path, body) {
  try {
    const res = await fetch(`${appiumUrl}${path}`, { method, headers: { 'content-type': 'application/json' },
      body: body && JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT) })
    return (await res.json()).value
  } catch (e) { return { error: String(e) } }
}
function appium(extra) {
  let session
  return {
    async read() {
      session ??= (await wd('POST', '/session', { capabilities: { alwaysMatch: { platformName: 'Android',
        'appium:automationName': 'UiAutomator2', 'appium:udid': serial, 'appium:noReset': true, ...extra } } }))?.sessionId
      if (!session) return 'no session'
      const source = await wd('GET', `/session/${session}/source`)
      return typeof source === 'string' ? source : JSON.stringify(source)
    },
    async close() { if (session) await wd('DELETE', `/session/${session}`) },
  }
}

function maestroMcp() {
  let child, buffer = '', id = 0
  const pending = new Map()
  const call = (method, params) => new Promise((resolve) => {
    const n = ++id
    pending.set(n, resolve)
    setTimeout(() => resolve(null), TIMEOUT).unref()
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`)
  })
  return {
    async read() {
      if (!child) {
        child = spawn('maestro', ['mcp'], { stdio: ['pipe', 'pipe', 'ignore'] })
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
          buffer += chunk
          for (let end; (end = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(end + 1)) {
            try { const message = JSON.parse(buffer.slice(0, end)); pending.get(message.id)?.(message) } catch {}
          }
        })
        await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'adrive-bench', version: '1' } })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      }
      return JSON.stringify(await call('tools/call', { name: 'inspect_screen', arguments: { device_id: serial } }))
    },
    close() { child?.kill() },
  }
}

function maestroCli() {
  let installed = false
  return {
    read() {
      const out = run('maestro', ['--device', serial, 'hierarchy', ...(installed ? ['--no-reinstall-driver'] : [])])
      installed = true
      return out
    },
  }
}

const dumpFile = '/sdcard/adrive-bench.xml'
const tools = [
  ['adrive', true, () => ({ read: () => run(adrive, ['ui']) })],
  ['adrive, `ADRIVE_NO_DAEMON=1`', true, () => ({ read: () => run(adrive, ['ui'], { ADRIVE_NO_DAEMON: '1' }) })],
  ['`uiautomator dump`', true, () => ({ read: () => adb('shell', `rm -f ${dumpFile}; uiautomator dump ${dumpFile}; cat ${dumpFile}`) })],
  ['`maestro hierarchy`', has('maestro'), maestroCli],
  ['`maestro mcp`, `inspect_screen`', has('maestro'), maestroMcp],
  ['Appium UiAutomator2, defaults', !!appiumUrl, () => appium({})],
  ['Appium UiAutomator2, `waitForIdleTimeout: 0`', !!appiumUrl, () => appium({ 'appium:settings[waitForIdleTimeout]': 0 })],
]

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]
const seconds = (ms) => `${(ms / 1000).toFixed(2)} s`

if (!adb('shell', 'pm', 'path', PKG).includes('package:')) {
  if (!existsSync(apk)) { console.error('run bench/fixture/build.sh first'); process.exit(1) }
  adb('install', '-r', apk)
}

const rows = []
for (const [name, available, create] of tools) {
  if (!available) { rows.push(`| ${name} | not run | | | |`); continue }
  reset()
  const tool = create()
  const calls = []
  for (let i = 0; i <= RUNS; i++) {
    const start = performance.now()
    const out = await tool.read()
    calls.push({ ms: performance.now() - start, ok: out.includes(NEEDLE) })
    process.stderr.write(`${name} ${i}/${RUNS} ${calls.at(-1).ok ? 'ok' : 'FAIL'} ${Math.round(calls.at(-1).ms)} ms\n`)
  }
  await tool.close?.()
  const later = calls.slice(1).map((c) => c.ms).sort((a, b) => a - b)
  rows.push(`| ${name} | ${calls.filter((c) => c.ok).length}/${calls.length} | ${seconds(calls[0].ms)} | ${seconds(percentile(later, 0.5))} | ${seconds(percentile(later, 0.9))} |`)
}
reset()

const prop = (key) => adb('shell', 'getprop', key).trim()
const versions = [`adrive ${run('git', ['-C', here, 'rev-parse', '--short', 'HEAD']).trim()}`]
if (has('maestro')) versions.push(`Maestro ${run('maestro', ['--version']).trim().split('\n').at(-1)}`)
if (appiumUrl) versions.push(`Appium ${(await wd('GET', '/status'))?.build?.version ?? 'unknown'}`)
console.log(`${prop('ro.product.model')}, Android ${prop('ro.build.version.release')} (API ${prop('ro.build.version.sdk')}). ${versions.join(', ')}.`)
console.log(`${RUNS + 1} calls per tool on \`${PKG}\`; a call succeeds when its output contains "${NEEDLE}".\n`)
console.log('| Tool | Read the tree | First call | Later calls, median | Later calls, p90 |')
console.log('| --- | --- | --- | --- | --- |')
console.log(rows.join('\n'))
