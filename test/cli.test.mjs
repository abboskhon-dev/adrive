import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { quote } from '../adrive.mjs'

const dir = mkdtempSync(join(tmpdir(), 'adrive-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))
mkdirSync(join(dir, 'helper/build'), { recursive: true })
for (const file of ['adrive.mjs', 'mcp.mjs']) copyFileSync(new URL(`../${file}`, import.meta.url), join(dir, file))
writeFileSync(join(dir, 'package.json'), '{"version":"0.0.0"}')
writeFileSync(join(dir, 'helper/build/classes.dex'), 'fixture')
const callsFile = join(dir, 'calls.jsonl')
const bin = join(dir, 'adb')
writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args)+'\\n');
const cmd = args[1] || '';
if (cmd.includes('--serve')) process.stdout.write(process.env.SERVE_PID || '');
else if (cmd.includes('app_process')) {
  const n = Number(fs.existsSync(process.env.CALLS + '.d') ? fs.readFileSync(process.env.CALLS + '.d', 'utf8') : 0);
  fs.writeFileSync(process.env.CALLS + '.d', String(n + 1));
  process.stdout.write(process.env['DUMP' + n] ?? process.env.DUMP);
}
else if (args[0] === 'get-serialno') process.stdout.write((process.env.SERIALNO || 'device-1') + '\\n');
else if (cmd.startsWith('kill -0') && process.env.ALIVE_ONCE) {
  if (!fs.existsSync(process.env.CALLS + '.alive')) { fs.writeFileSync(process.env.CALLS + '.alive', ''); process.stdout.write('up'); }
}
else if (cmd.startsWith('kill -0')) process.stdout.write(process.env.ALIVE || '');
else if (cmd.startsWith('perfetto ')) process.stdout.write('777\\n');
else if (args[0] === 'pull') fs.writeFileSync(args[2], process.env.PULL ?? 'trace');
else if (args[0] === 'forward' && args[1] === '--list') process.stdout.write(process.env.FORWARD || '');
else if (cmd.includes('md5sum')) process.stdout.write('f16d05ec6b29228d2c61adb1e9263f78  file');
else if (cmd === "'dumpsys' 'window'") process.stdout.write(process.env.FOCUS);
else if (cmd.startsWith('pidof ')) process.stdout.write('1234');
else if (cmd === 'dumpsys window displays') process.stdout.write(process.env.DISPLAYS || '');
else if (cmd === 'wm size') process.stdout.write(process.env.WM_SIZE || '');
else if (cmd === "'dumpsys' 'media.audio_flinger'") process.stdout.write(process.env.AUDIO || '');
else if (cmd.startsWith('p=$(pidof')) {
  const n = Number(fs.existsSync(process.env.CALLS + '.n') ? fs.readFileSync(process.env.CALLS + '.n', 'utf8') : 0);
  fs.writeFileSync(process.env.CALLS + '.n', String(n + 1));
  if (String(n) === process.env.FAIL_SAMPLE) process.exit(1);
  process.stdout.write(process.env['SAMPLE' + n] ?? process.env.SAMPLE ?? 'pid ');
}
else if (args[0] === 'logcat') process.stdout.write(process.env.LOGS || 'foo.bar match\\nother\\n');
`, { mode: 0o755 })
const node = (fields = {}) => ({ class: 'android.widget.Button', text: 'Delete', desc: '', id: '',
  x: 100, y: 200, left: 50, top: 150, right: 150, bottom: 250, clickable: true, enabled: true, ...fields })
const window = (nodes, id = 1) => ({ id, type: 1, layer: 0, package: 'com.example', nodes })
const environment = (extra) => ({ ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: callsFile,
  DUMP: JSON.stringify({ version: 1, windows: [window([node()])] }),
  FOCUS: 'mCurrentFocus=Window{a u0 com.example/.MainActivity}', ADRIVE_NO_DAEMON: '1', XDG_CACHE_HOME: join(dir, 'cache'), ...extra })
const recorded = () => readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
function run(args, extra = {}) {
  writeFileSync(callsFile, '')
  rmSync(`${callsFile}.n`, { force: true })
  rmSync(`${callsFile}.d`, { force: true })
  rmSync(`${callsFile}.alive`, { force: true })
  const result = spawnSync(process.execPath, [join(dir, 'adrive.mjs'), ...args], {
    encoding: 'utf8', timeout: 5000, env: environment(extra) })
  return { ...result, calls: recorded() }
}
// The daemon tests answer from this process, so the CLI must not block it.
function runWithDaemon(args, port, extra = {}) {
  writeFileSync(callsFile, '')
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(dir, 'adrive.mjs'), ...args], { env: environment({
      ADRIVE_NO_DAEMON: '', ANDROID_SERIAL: 'device-1',
      FORWARD: port ? `other tcp:1 localabstract:adrive\ndevice-1 tcp:${port} localabstract:adrive\n` : '', ...extra }) })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (status) => resolve({ status, stdout, stderr, calls: recorded() }))
  })
}
// Each connection gets the next reply; null closes without answering, like adb with no helper listening.
async function fakeDaemon(...replies) {
  const requests = []
  const server = createServer((socket) => {
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      data += chunk
      if (!data.endsWith('\n')) return
      requests.push(JSON.parse(data))
      const reply = replies.length > 1 ? replies.shift() : replies[0]
      socket.end(reply === null ? '' : `${JSON.stringify(reply)}\n`)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, requests, close: () => new Promise((resolve) => server.close(resolve)) }
}
function ok(result) { assert.equal(result.status, 0, result.stderr); return result }
const shellCommand = (...args) => ['shell', args.map(quote).join(' ')]
const isInput = (c) => c[0] === 'shell' && c[1].startsWith("'input'")

test('bad actions fail before invoking adb', () => {
  for (const args of [ ['tap'], ['tap', ''], ['longpress'], ['slide', '0.5'],
    ['tap', 'Delete', '--nth', '-1'], ['tap', 'Delete', '--nth'], ['tap', 'Delete', '--nth', '1.5'],
    ['key', '66; echo injected'], ['swipe', '0', '0', '1', '1', '300; echo injected'],
    ['swipe', '0', 'NaN', '1', '1'], ['launch'], ['stop'], ['clear'],
    ['clear', 'com.example; echo injected'], ['launch', 'com.example', 'extra'],
    ['wait', 'Delete', 'Infinity'], ['gone', 'Delete', '-1'], ['open'], ['log', '--lines', '0'],
    ['log', '--package', 'com.example; echo injected'], ['log', '['], ['wat'] ]) {
    const result = run(args)
    assert.equal(result.status, 1, JSON.stringify(args))
    assert.deepEqual(result.calls, [], JSON.stringify(args))
  }
})
test('UI text never becomes coordinates, IDs, or clickable metadata', () => {
  const text = 'Email @12,34 clickable id=spoof\n"quoted"\\tail'
  const dump = { version: 1, windows: [window([node({ text, clickable: false }), node({ text: 'Other', x: 300 })])] }
  const result = ok(run(['tap', text], { DUMP: JSON.stringify(dump) }))
  assert.deepEqual(result.calls.filter(isInput).at(-1), shellCommand('input', 'tap', 100, 200))
  assert.equal(run(['tap', 'spoof'], { DUMP: JSON.stringify({ version: 1, windows: [window([node({ text: 'Other', desc: 'metadata id=fake' })])] }) }).status, 1)
})
test('signed centers and exact multiline queries survive JSON', () => {
  const result = ok(run(['tap', 'first\nsecond'], { DUMP: JSON.stringify({ version: 1, windows: [window([node({ text: 'first\nsecond', x: -10 })])] }) }))
  assert.deepEqual(result.calls.filter(isInput).at(-1), shellCommand('input', 'tap', -10, 200))
})
test('JSON output preserves windows and values; --windows reaches helper', () => {
  const data = { version: 1, windows: [window([node({ text: 'a\nb' })], 2), window([node()], 1)] }
  const result = ok(run(['ui', '--json', '--windows', '--all'], { DUMP: JSON.stringify(data) }))
  assert.deepEqual(JSON.parse(result.stdout), data)
  assert.match(result.calls.at(-1)[1], /Dump --all --windows$/)
  const tap = ok(run(['tap', 'Delete', '--windows', '--nth', '1'], { DUMP: JSON.stringify({ version: 1, windows: [window([node({ x: 10, clickable: false })], 2), window([node({ x: 20 })], 1)] }) }))
  assert.deepEqual(tap.calls.filter(isInput).at(-1), shellCommand('input', 'tap', 20, 200))
})
test('literal --nth and %s are typed without option or Android substitution', () => {
  assert.deepEqual(ok(run(['type', '--nth', '2'])).calls.filter(isInput), [shellCommand('input', 'text', '--nth%s2')])
  const result = ok(run(['type', 'a %s %%s']))
  assert.deepEqual(result.calls.filter(isInput), ['a%s', '%', 's%s', '%', '%', 's'].map(v => shellCommand('input', 'text', v)))
  assert.equal(run(['type', '한글']).status, 1)
})
test('shell quoting round trips punctuation without interpretation', () => {
  const value = "a'b; echo INJECTED $(echo bad) `echo bad` %s &"
  const decoded = spawnSync('/bin/sh', ['-c', `printf '%s' ${quote(value)}`], { encoding: 'utf8' })
  assert.equal(decoded.status, 0)
  assert.equal(decoded.stdout, value)
  assert.deepEqual(ok(run(['open', value])).calls, [shellCommand('am', 'start', '-a', 'android.intent.action.VIEW', '-d', value)])
})
test('dotted regex uses focused app; explicit package avoids focus lookup', () => {
  const result = ok(run(['log', 'foo.bar']))
  assert.equal(result.stdout.trim(), 'foo.bar match')
  assert.ok(result.calls.some(c => c[1] === "pidof 'com.example'; true"))
  const explicit = ok(run(['log', 'foo.bar', '--package', 'org.other']))
  assert.ok(!explicit.calls.some(c => c[1]?.includes("'window'")))
  const missing = run(['log'], { FOCUS: 'mCurrentFocus=null' })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /no focused app/)
})
test('crashes match exact process or colon subprocess, never package prefixes', () => {
  const crash = pkg => `11-11 10:00:00.000  1000  1000 E AndroidRuntime: FATAL EXCEPTION: main\n11-11 10:00:00.000  1000  1000 E AndroidRuntime: Process: ${pkg}, PID: 1000\n`
  const wrong = ok(run(['crash', '--package', 'com.example'], { LOGS: crash('com.example.other') }))
  assert.match(wrong.stdout, /no Java crash/)
  const right = ok(run(['crash', '--package', 'com.example'], { LOGS: crash('com.example:worker') + crash('com.example.other') }))
  assert.match(right.stdout, /Process: com.example:worker/)
  assert.doesNotMatch(right.stdout, /com.example.other/)
  assert.deepEqual(right.calls[0], ['logcat', '-d', '-b', 'crash', '-v', 'threadtime'])
})
test('literal target after -- and malformed helper output', () => {
  ok(run(['tap', '--', '--nth'], { DUMP: JSON.stringify({ version: 1, windows: [window([node({ text: '--nth' })])] }) }))
  const result = run(['ui'], { DUMP: 'broken' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /invalid helper JSON/)
})

test('CLI entry point also runs through a symlink', () => {
  const link = join(dir, 'adrive')
  symlinkSync(join(dir, 'adrive.mjs'), link)
  const result = spawnSync(process.execPath, [link, 'help'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /drive any Android app/)
})

test('audio reports only the app\'s tracks, live and closed with underruns', () => {
  const header = '    Type     Id Active Client Session Port Id S  Flags   Format Chn mask  SRate ST Usg CT  G db  L dB  R dB  VS dB   Server FrmCnt  FrmRdy F Underruns  Flushed'
  const row = (id, active, client, under) => `${id}  ${active}  ${client}  3753  339 P  0x400 00000005 00000003  44100  3   1  2  -inf  0  0  0  0195FB40  3848  1928 A  ${under}  0`
  const AUDIO = ['Output thread 0xb4, name AudioOut_15, tid 1645, type 0 (MIXER):', '  Standby: no', '  Sample rate: 48000 Hz',
    '  AudioStreamOut: 0xb4 flags 0x8 (AUDIO_OUTPUT_FLAG_DEEP_BUFFER)', '  Normal mixer raw underrun counters: partial=1 empty=2',
    '  2 Tracks of which 1 are active', header, '            ' + row(317, 'yes', 1234, 0), '            ' + row(318, 'no', 999, 50),
    '  Local log:', '   11-13 08:25:37.718 removeTrack_l (0xb4)  ' + row(454, 'no', 1234, 2530),
    '   11-13 08:25:38.000 removeTrack_l (0xb4)  ' + row(455, 'no', 1234, 0),
    'Output thread 0xb5, name AudioOut_1D, tid 1650, type 0 (MIXER):', header, '            ' + row(319, 'no', 999, 7)].join('\n')
  const json = JSON.parse(ok(run(['audio', '--package', 'com.example', '--json'], { AUDIO })).stdout)
  assert.equal(json.threads.length, 1)
  const [thread] = json.threads
  assert.equal(thread.output, 'DEEP_BUFFER')
  assert.deepEqual(thread.mixerUnderruns, { partial: 1, empty: 2 })
  assert.deepEqual(thread.tracks.map(t => [t.id, t.active, t.underruns]), [[317, true, 0]])
  assert.deepEqual(thread.history.map(t => [t.id, t.underruns]), [[454, 2530], [455, 0]])
  const text = ok(run(['audio', '--package', 'com.example'], { AUDIO })).stdout
  assert.match(text, /08:25:37.718 track 454 .*underrun frames 2530 \(57.4 ms\)/)
  assert.doesNotMatch(text, /track 455|track 318/)
})

const fixtureHash = createHash('md5').update('fixture').digest('hex')
const helperCalls = (calls) => calls.filter(c => /app_process|md5sum/.test(c[1] ?? ''))

test('a running daemon answers without starting the helper', async () => {
  const data = { version: 1, windows: [window([node({ text: 'From daemon', x: 7 })])] }
  const daemon = await fakeDaemon(data)
  try {
    const ui = await runWithDaemon(['ui', '--json', '--all', '--windows'], daemon.port)
    assert.equal(ui.status, 0, ui.stderr)
    assert.deepEqual(JSON.parse(ui.stdout), data)
    assert.deepEqual(daemon.requests, [{ hash: fixtureHash, all: true, windows: true }])
    assert.deepEqual(ui.calls, [['forward', '--list']])
  } finally { await daemon.close() }
})
test('actions go through the daemon, and fall back to input when it cannot inject', async () => {
  const data = { version: 1, windows: [window([node({ text: 'From daemon', x: 7 })])], seq: 3 }
  const daemon = await fakeDaemon(data, { ok: true }, data, { error: 'java.lang.IllegalStateException: x', restart: true })
  try {
    const tap = await runWithDaemon(['tap', '--quiet', 'From daemon'], daemon.port)
    assert.equal(tap.status, 0, tap.stderr)
    assert.deepEqual(daemon.requests[1], { hash: fixtureHash, cmd: 'tap', x: 7, y: 200 })
    assert.ok(!tap.calls.some((c) => c[1]?.startsWith("'input'")))
    const fallback = await runWithDaemon(['tap', '--quiet', 'From daemon'], daemon.port)
    assert.deepEqual(fallback.calls.filter(isInput).at(-1), shellCommand('input', 'tap', 7, 200))
  } finally { await daemon.close() }
  const bad = await fakeDaemon({ error: 'unknown key KEYCODE_NOPE' })
  try {
    const key = await runWithDaemon(['key', '--quiet', 'KEYCODE_NOPE'], bad.port)
    assert.equal(key.status, 1)
    assert.match(key.stderr, /unknown key KEYCODE_NOPE/)
  } finally { await bad.close() }
})
test('wait sleeps until the daemon reports a change, and ui --json hides the event count', async () => {
  const empty = { version: 1, windows: [window([node({ text: 'Loading' })])], seq: 5 }
  const ready = { version: 1, windows: [window([node({ text: 'Ready' })])], seq: 9 }
  const daemon = await fakeDaemon(empty, { seq: 9 }, ready)
  try {
    const wait = await runWithDaemon(['wait', 'Ready', '5'], daemon.port)
    assert.equal(wait.status, 0, wait.stderr)
    assert.deepEqual(daemon.requests.map((r) => r.cmd ?? 'dump'), ['dump', 'change', 'dump'])
    assert.equal(daemon.requests[1].seq, 5)
  } finally { await daemon.close() }
  const shown = await fakeDaemon(ready)
  try { assert.equal(JSON.parse((await runWithDaemon(['ui', '--json'], shown.port)).stdout).seq, undefined) } finally { await shown.close() }
})
test('a missing or stale daemon is started with the current helper, then asked again', async () => {
  const data = { version: 1, windows: [window([node()])] }
  for (const first of [null, { error: 'stale' }]) {
    const daemon = await fakeDaemon(first, data)
    try {
      const result = await runWithDaemon(['ui', '--json'], daemon.port, { ADRIVE_DAEMON_IDLE: '5' })
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), data)
      assert.equal(daemon.requests.length, 2)
      const [check, start] = helperCalls(result.calls)
      assert.match(check[1], /md5sum/)
      assert.match(start[1], new RegExp(`Dump --serve ${fixtureHash} 5 >/dev/null 2>&1 & echo \\$!$`))
    } finally { await daemon.close() }
  }
})
test('a daemon error is reported; no forward falls back to one helper run', async () => {
  const daemon = await fakeDaemon({ error: 'java.lang.IllegalStateException: no accessible active window' })
  try {
    const failed = await runWithDaemon(['ui'], daemon.port)
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /no accessible active window/)
    assert.deepEqual(helperCalls(failed.calls), [])
  } finally { await daemon.close() }
  const fallback = await runWithDaemon(['ui', '--all'], 0)
  assert.equal(fallback.status, 0, fallback.stderr)
  assert.deepEqual(fallback.calls.slice(0, 2), [['forward', '--list'], ['forward', 'tcp:0', 'localabstract:adrive']])
  assert.match(fallback.calls.at(-1)[1], /Dump --all$/)
  assert.equal((await runWithDaemon(['ui'], 0, { ADRIVE_DAEMON_IDLE: '0' })).status, 1)
})
test('a helper that loses its connection exits, and the command reruns once', async () => {
  const daemon = await fakeDaemon({ error: 'java.lang.IllegalStateException: UiAutomation not connected', restart: true })
  try {
    const result = await runWithDaemon(['ui'], daemon.port)
    assert.equal(result.status, 0, result.stderr)
    assert.match(helperCalls(result.calls).at(-1)[1], /Dump$/)
  } finally { await daemon.close() }
})
test('a starting helper is waited on until it answers or exits', async () => {
  const daemon = await fakeDaemon(null)
  try {
    const result = await runWithDaemon(['ui'], daemon.port, { SERVE_PID: '4321\n' })
    assert.equal(result.status, 0, result.stderr)
    const checks = result.calls.filter((c) => /^kill -0 4321/.test(c[1] ?? ''))
    assert.equal(checks.length, 1)
    assert.match(helperCalls(result.calls).at(-1)[1], /Dump$/)
  } finally { await daemon.close() }
})
test('without ANDROID_SERIAL, only the default device\'s forward is used', async () => {
  const daemon = await fakeDaemon({ version: 1, windows: [window([node()])] })
  try {
    const result = await runWithDaemon(['ui'], daemon.port, { ANDROID_SERIAL: '', SERIALNO: 'device-2' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(daemon.requests, [])
    assert.deepEqual(result.calls.slice(0, 3), [['get-serialno'], ['forward', '--list'], ['forward', 'tcp:0', 'localabstract:adrive']])
  } finally { await daemon.close() }
})
test('daemon status and stop never start a helper', async () => {
  const daemon = await fakeDaemon({ ok: true, pid: 42, idleSeconds: 30 })
  try {
    const status = await runWithDaemon(['daemon', 'status'], daemon.port)
    assert.equal(status.stdout.trim(), 'running (pid 42, exits after 30 s idle)')
    const stop = await runWithDaemon(['daemon', 'stop'], daemon.port)
    assert.equal(stop.stdout.trim(), 'stopped')
    assert.deepEqual(stop.calls, [['forward', '--list'], ['forward', '--remove', `tcp:${daemon.port}`]])
    assert.deepEqual(daemon.requests, [{ cmd: 'status' }, { cmd: 'stop' }])
  } finally { await daemon.close() }
  const none = await runWithDaemon(['daemon', 'status'], 0)
  assert.equal(none.stdout.trim(), 'not running')
  assert.deepEqual(none.calls, [['forward', '--list']])
  assert.equal(run(['daemon']).status, 1)
  assert.equal(run(['daemon', 'start']).status, 1)
})

test('mcp lists tools and runs them with literal arguments', () => {
  const messages = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'tap', arguments: { target: '--nth' } } },
    { id: 4, method: 'tools/call', params: { name: 'tap', arguments: { target: 'delete' } } },
    { id: 5, method: 'tools/call', params: { name: 'tap', arguments: { target: 'delete', nth: '1' } } },
    { id: 6, method: 'missing' },
    { id: 7, method: 'tools/call', params: { name: 'wait', arguments: { query: 'x', seconds: 61 } } },
    { id: 8, method: 'tools/call', params: { name: 'look', arguments: {} } },
    { id: 9, method: 'tools/call', params: { name: 'tap', arguments: { target: '@1' } } },
  ].map((m) => JSON.stringify({ jsonrpc: '2.0', ...m })).join('\n')
  writeFileSync(callsFile, '')
  const result = ok(spawnSync(process.execPath, [join(dir, 'adrive.mjs'), 'mcp'], {
    input: messages, encoding: 'utf8', timeout: 5000, env: environment() }))
  const replies = result.stdout.trim().split('\n').map(JSON.parse)
  assert.deepEqual(replies.map((r) => r.id), [1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.equal(replies[0].result.protocolVersion, '2025-06-18')
  assert.ok(replies[1].result.tools.some((t) => t.name === 'clear' && t.annotations.destructiveHint))
  assert.match(replies[2].result.content[0].text, /no element matches "--nth"/)
  assert.equal(replies[2].result.isError, true)
  assert.match(replies[3].result.content[0].text, /^tapped Button text="Delete"/)
  assert.equal(replies[4].result.content[0].text, 'nth must be a number')
  assert.equal(replies[5].error.code, -32601)
  assert.equal(replies[6].result.content[0].text, 'seconds must be <= 60')
  assert.equal(replies[7].result.content[0].text, '[1] Button "Delete"')
  assert.match(replies[8].result.content[0].text, /^tapped Button text="Delete"/)
  assert.deepEqual(recorded().filter((c) => c[0] === 'shell' && c[1].startsWith("'input'")), [shellCommand('input', 'tap', 100, 200), shellCommand('input', 'tap', 100, 200)])
})

const stepsFile = join(dir, 'steps.json')
const stat = (tid, name, ticks) => `${tid} (${name}) S 1 1 0 0 -1 0 0 0 0 0 ${ticks} 0 0 0 20 0 1 0`
const sampleOut = (ticks, pss, frames) => [`pid 1234`, stat(1234, 'main', ticks[0]), stat(1240, 'RenderThread', ticks[1]),
  '---', `        TOTAL PSS:   ${pss}            TOTAL RSS:   1`, '---',
  `Total frames rendered: ${frames}`, 'Janky frames: 3 (10.00%)', '50th percentile: 6ms', '90th percentile: 12ms', '99th percentile: 40ms',
  '---', stat(1234, 'main', ticks[0] + 1), stat(1240, 'RenderThread', ticks[1])].join('\n')

test('bad steps fail before invoking adb', () => {
  for (const steps of ['nope', '[]', '{}', '[["run","x"]]', '[["daemon","stop"]]', '[[1]]', '[{"do":["tap","x"],"settle":-1}]']) {
    writeFileSync(stepsFile, steps)
    const result = run(['run', stepsFile, '--package', 'com.example'])
    assert.equal(result.status, 1, steps)
    assert.deepEqual(result.calls, [], steps)
  }
})
test('run reports frames, CPU by thread and PSS per step', () => {
  writeFileSync(stepsFile, JSON.stringify([['tap', 'Delete'], { do: ['key', 'back'], settle: 0.01 }]))
  const result = ok(run(['run', stepsFile, '--package', 'com.example', '--json'], {
    SAMPLE0: sampleOut([10, 5], 1000, 0), SAMPLE1: sampleOut([20, 35], 1500, 30), SAMPLE2: sampleOut([21, 35], 1400, 2) }))
  const { steps } = JSON.parse(result.stdout)
  assert.deepEqual(steps.map((s) => [s.cpuMs, s.threads, s.pssKb, s.pssDeltaKb, s.frames.total]), [
    [390, [{ name: 'RenderThread', ms: 300 }, { name: 'main', ms: 90 }], 1500, 500, 30],
    [0, [], 1400, -100, 2]])
  const idle = JSON.parse(ok(run(['run', stepsFile, '--package', 'com.example', '--json'], { SAMPLE: sampleOut([1, 1], 1000, 0) })).stdout)
  assert.deepEqual(idle.steps[0].frames, { total: 0, janky: 0, p50: null, p90: null, p99: null })
  assert.deepEqual(steps[1].frames, { total: 2, janky: 3, p50: 6, p90: 12, p99: 40 })
  assert.match(steps[0].output, /^tapped Button/)
  const order = result.calls.map((c) => c[1]?.startsWith('p=$(pidof') ? 'sample' : c[1]?.startsWith("'input'") ? 'input' : null).filter(Boolean)
  assert.deepEqual(order, ['sample', 'input', 'sample', 'input', 'sample'])
})
test('a failing step is reported and ends the run', () => {
  writeFileSync(stepsFile, JSON.stringify([['tap', 'Missing'], ['key', 'back']]))
  const result = run(['run', stepsFile, '--package', 'com.example'], { SAMPLE: sampleOut([1, 1], 1000, 5) })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /^1 tap Missing .*FAILED: no element matches/)
  assert.match(result.stderr, /step 1 failed/)
  assert.ok(!result.calls.some((c) => c[1]?.includes('keyevent')))
})
test('a trace is stopped, waited on and pulled', () => {
  writeFileSync(stepsFile, JSON.stringify([['key', 'back']]))
  const out = join(dir, 'run.perfetto-trace')
  const result = ok(run(['run', stepsFile, '--package', 'com.example', '--trace', out], { SAMPLE: sampleOut([1, 1], 1000, 5), ALIVE_ONCE: '1' }))
  assert.equal(readFileSync(out, 'utf8'), 'trace')
  const trace = result.calls.map((c) => c[0] === 'pull' ? 'pull' : c[1]?.split(' ').slice(0, 2).join(' ')).filter((c) => /^(perfetto|kill|pull|rm)/.test(c))
  assert.deepEqual(trace, ['perfetto --background', 'kill -TERM', 'kill -0', 'kill -0', 'pull', 'rm -f'])
  const empty = run(['run', stepsFile, '--package', 'com.example', '--trace', out, '--json'], { SAMPLE: sampleOut([1, 1], 1000, 5), PULL: '' })
  assert.equal(empty.status, 1)
  assert.match(empty.stderr, /empty trace/)
  const report = JSON.parse(empty.stdout)
  assert.equal(report.steps.length, 1)
  assert.equal(report.trace, undefined)
})
test('a failed measurement still stops the trace and reports earlier steps', () => {
  writeFileSync(stepsFile, JSON.stringify([['key', 'back'], ['key', 'home']]))
  const out = join(dir, 'run.perfetto-trace')
  for (const [fail, steps] of [['0', 0], ['2', 1]]) {
    const result = run(['run', stepsFile, '--package', 'com.example', '--trace', out, '--json'], { SAMPLE: sampleOut([1, 1], 1000, 5), FAIL_SAMPLE: fail })
    assert.equal(result.status, 1, fail)
    assert.equal(JSON.parse(result.stdout).steps.length, steps, fail)
    assert.ok(result.calls.some((c) => c[1]?.startsWith('kill -TERM 777')), fail)
  }
})
test('mcp run returns per-step JSON, and the measured steps on failure', () => {
  const messages = [
    { id: 1, method: 'tools/call', params: { name: 'run', arguments: { steps: [['key', 'back'], { do: ['tap', 'Delete'], settle: 0 }], package: 'com.example' } } },
    { id: 2, method: 'tools/call', params: { name: 'run', arguments: { steps: [['key', 'back'], ['tap', 'Missing']], package: 'com.example' } } },
    { id: 3, method: 'tools/call', params: { name: 'run', arguments: { steps: 'nope' } } },
    { id: 4, method: 'tools/call', params: { name: 'run', arguments: { steps: [['shot', '/tmp/x.png']] } } },
    { id: 5, method: 'tools/call', params: { name: 'run', arguments: { steps: [['wait', '--windows', '--', 'x', '61']] } } },
    { id: 6, method: 'tools/call', params: { name: 'run', arguments: { steps: [{ do: ['key', 'back'], settle: 61 }] } } },
    { id: 7, method: 'tools/call', params: { name: 'run', arguments: { steps: [['key', 'back']], package: 'com.example', trace: true } } },
  ].map((m) => JSON.stringify({ jsonrpc: '2.0', ...m })).join('\n')
  writeFileSync(callsFile, '')
  rmSync(`${callsFile}.n`, { force: true })
  const result = ok(spawnSync(process.execPath, [join(dir, 'adrive.mjs'), 'mcp'], {
    input: messages, encoding: 'utf8', timeout: 5000, env: environment({ SAMPLE: sampleOut([1, 1], 1000, 5) }) }))
  const [passed, failed, invalid, shot, wait, settle, traced] = result.stdout.trim().split('\n').map(JSON.parse)
  assert.deepEqual(JSON.parse(passed.result.content[0].text).steps.map((s) => s.frames.total), [5, 5])
  assert.equal(failed.result.isError, true)
  assert.equal(JSON.parse(failed.result.content[0].text).steps.length, 2)
  assert.match(failed.result.content[1].text, /step 2 failed: no element matches "Missing"/)
  assert.equal(invalid.result.content[0].text, 'steps must be an array')
  assert.match(shot.result.content[0].text, /shot is CLI-only/)
  for (const r of [wait, settle]) assert.match(r.result.content[0].text, /<= 60 seconds/)
  const tracePath = JSON.parse(traced.result.content[0].text).trace
  assert.ok(tracePath.startsWith(tmpdir()))
  assert.equal(readFileSync(tracePath, 'utf8'), 'trace')
  rmSync(dirname(tracePath), { recursive: true })
})
test('scroll uses the rotated screen size, then wm size, and fails clearly without either', () => {
  const landscape = ok(run(['scroll', 'down'], { DISPLAYS: '  init=1080x2340 420dpi cur=2340x1080 app=2340x1017', WM_SIZE: 'Physical size: 1080x2340' }))
  assert.deepEqual(landscape.calls.filter(isInput).at(-1), shellCommand('input', 'swipe', 1170, 864, 1170, 216, 300))
  const fallback = ok(run(['scroll', 'down'], { WM_SIZE: 'Physical size: 1080x2340\n' }))
  assert.deepEqual(fallback.calls.filter(isInput).at(-1), shellCommand('input', 'swipe', 540, 1872, 540, 468, 300))
  assert.match(run(['scroll', 'down']).stderr, /could not read the screen size/)
})
test('wait keeps waiting through a screen with no windows', () => {
  const result = run(['wait', 'Delete', '0.5'], { DUMP: JSON.stringify({ version: 1, windows: [] }) })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /timed out waiting/)
  assert.match(run(['ui'], { DUMP: JSON.stringify({ version: 1, windows: [] }) }).stderr, /no accessible window/)
})
test('a gesture the helper cancelled is not replayed through input', async () => {
  const daemon = await fakeDaemon({ error: 'Android refused the gesture after it started; it was cancelled' })
  const result = await runWithDaemon(['tap', '--quiet', '10,20'], daemon.port)
  await daemon.close()
  assert.equal(result.status, 1)
  assert.ok(!result.calls.some((c) => c[1]?.includes("'input'")))
})
test('ADRIVE_NO_DAEMON only disables the daemon when set to 1', async () => {
  const daemon = await fakeDaemon({ ok: true })
  const result = await runWithDaemon(['key', '--quiet', 'back'], daemon.port, { ADRIVE_NO_DAEMON: '0' })
  await daemon.close()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(daemon.requests.length, 1)
})
test('version prints the package version', () => {
  assert.equal(ok(run(['--version'])).stdout, '0.0.0\n')
  assert.equal(ok(run(['version'])).stdout, '0.0.0\n')
})
test('mcp answers non-object messages and keeps serving', () => {
  const input = ['null', '[]', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })].join('\n')
  const result = ok(spawnSync(process.execPath, [join(dir, 'adrive.mjs'), 'mcp'], { input, encoding: 'utf8', timeout: 5000, env: environment() }))
  const [first, second, ping] = result.stdout.trim().split('\n').map(JSON.parse)
  assert.equal(first.error.code, -32600)
  assert.equal(second.error.code, -32600)
  assert.deepEqual(ping.result, {})
})

test('look numbers actionable elements, and a ref acts only while the element is unmoved', () => {
  const serial = `look-${process.pid}`
  const play = node({ text: 'Play', x: 10, y: 20 })
  const screen = (nodes) => ({ DUMP: JSON.stringify({ version: 1, windows: [window(nodes)] }), SERIALNO: serial, ANDROID_SERIAL: '' })
  const label = node({ class: 'android.widget.TextView', text: 'Title', clickable: false })
  const field = node({ class: 'android.widget.EditText', text: '', id: 'app:id/name', clickable: false, editable: true })
  const seek = node({ class: 'android.widget.SeekBar', text: '', clickable: false, left: 0, right: 1000, y: 500 })
  const taps = (result) => result.calls.filter((c) => c[0] === 'shell' && c[1].startsWith("'input'"))
  // Before any look, @text is still matched as text.
  assert.deepEqual(ok(run(['tap', '@2024'], screen([node({ text: '@2024', x: 7 })]))).calls.filter(isInput).at(-1), shellCommand('input', 'tap', 7, 200))
  assert.match(run(['tap', '@1'], screen([play])).stderr, /no refs yet and no element matches "@1"/)
  const look = ok(run(['look'], screen([label, play, node(), field, seek])))
  assert.equal(look.stdout, '[1] Button "Play"\n[2] Button "Delete"\n[3] EditText "name" editable\n[4] SeekBar\n')
  assert.deepEqual(ok(run(['tap', '@2'], screen([play, node()]))).calls.filter(isInput).at(-1), shellCommand('input', 'tap', 100, 200))
  assert.deepEqual(ok(run(['slide', '@4', '1'], screen([seek]))).calls.filter(isInput).at(-1), shellCommand('input', 'swipe', 24, 500, 976, 500, 700))
  // A unique ID keeps the ref through a changed label.
  ok(run(['tap', '@3'], screen([{ ...field, text: 'Ada' }])))
  for (const [args, now, error] of [
    [['tap', '@1'], [node({ text: 'Play', left: 60 })], /@1 \[1\] Button "Play" is gone or moved/],
    [['tap', '@9'], [play], /@9 is not in the last look \(4 refs\)/],
    [['tap', '@3'], [{ ...field, top: 0 }], /@3 .* is gone or moved/],
    [['tap', '@3'], [{ ...field, text: 'a' }, { ...field, text: 'b', top: 0 }], /@3 .* is gone or moved/],
    [['tap', '@1', '--nth', '0'], [play], /--nth does not apply to refs/],
    [['tap', '@1', '--windows'], [play], /from `adrive look`; pass the same --windows/]]) {
    const result = run(args, screen(now))
    assert.match(result.stderr, error)
    assert.deepEqual(taps(result), [])
  }
})

test('actions print what changed once the screen settles, ignoring animating labels', () => {
  const label = (text, top) => node({ class: 'android.widget.TextView', text, clickable: false, top, bottom: top + 50 })
  const screen = (i, nodes) => JSON.stringify({ version: 1, windows: [window([label(`0:0${i}`, 0), ...nodes])] })
  const env = { DUMP0: screen(0, [node(), label('taps 1', 300), label('Loading', 400)]) }
  for (let i = 1; i < 40; i++) env[`DUMP${i}`] = screen(i, [node(), label('taps 2', 300), node({ text: 'Ready', top: 500 })])
  const result = ok(run(['tap', 'Delete'], env))
  assert.equal(result.stdout, 'tapped Button text="Delete" clickable @100,200 [50,150,150,250]\n'
    + 'appeared: Button "Ready"\ngone: TextView "Loading"\nchanged: TextView "taps 1" -> "taps 2"\n')
  // The target lookup doubles as the screen before.
  assert.equal(result.calls.slice(0, result.calls.findIndex(isInput)).filter((c) => c[1]?.includes('app_process')).length, 1)
  const json = JSON.parse(ok(run(['tap', '--json', 'Delete'], env)).stdout)
  assert.match(json.done, /^tapped/)
  assert.deepEqual([json.settled, json.appeared.map((n) => n.text), json.gone.map((n) => n.text), json.changed.map((c) => c.to.text)],
    [true, ['Ready'], ['Loading'], ['taps 2']])
  assert.equal(ok(run(['key', 'back'])).stdout, 'no change\n')
  const many = { DUMP0: JSON.stringify({ version: 1, windows: [window(Array.from({ length: 12 }, (_, i) => node({ text: `Stem ${i}` })))] }),
    DUMP: JSON.stringify({ version: 1, windows: [{ ...window([]), package: 'com.launcher' }] }) }
  const back = ok(run(['key', 'back'], many)).stdout.split('\n')
  assert.deepEqual([back[0], back[1], back.at(-2), back.length], ['screen: com.launcher', 'gone: Button "Stem 0"', 'gone: 2 more', 13])
  assert.equal(ok(run(['key', '--quiet', 'back'])).stdout, '')
  assert.match(run(['key', '--quiet', '--json', 'back']).stderr, /cannot be combined/)
})

test('a layout that keeps moving is reported after 2 s, not waited on forever', () => {
  const env = {}
  for (let i = 0; i < 80; i++) env[`DUMP${i}`] = JSON.stringify({ version: 1, windows: [window([node({ top: i })])] })
  const result = ok(run(['key', 'back'], env))
  assert.match(result.stdout, /still changing after 2 s\n$/)
})

test('type takes options only before an explicit --', () => {
  const quiet = ok(run(['type', '--quiet', '--', 'hi']))
  assert.equal(quiet.stdout, '')
  assert.deepEqual(quiet.calls.filter(isInput), [shellCommand('input', 'text', 'hi')])
  assert.deepEqual(ok(run(['type', '--quiet', 'hi'])).calls.filter(isInput), [shellCommand('input', 'text', '--quiet%shi')])
  for (const text of [['hello', '--', 'world'], ['--foo', '--', 'x']]) {
    assert.deepEqual(ok(run(['type', '--quiet', '--', ...text])).calls.filter(isInput), [shellCommand('input', 'text', text.join('%s'))])
    assert.deepEqual(ok(run(['type', ...text])).calls.filter(isInput), [shellCommand('input', 'text', text.join('%s'))])
  }
})
test('a toggled switch is a change, and the daemon settles once no event arrives', async () => {
  const mute = (checked) => node({ class: 'android.widget.Switch', text: 'Mute', checkable: true, checked })
  const before = { version: 1, windows: [window([mute(false)])], seq: 5 }
  const after = { version: 1, windows: [window([mute(true)])], seq: 7 }
  const daemon = await fakeDaemon(before, { ok: true }, after, { seq: 7 })
  try {
    const tap = await runWithDaemon(['tap', 'Mute'], daemon.port)
    assert.equal(tap.status, 0, tap.stderr)
    assert.match(tap.stdout, /\nchanged: Switch "Mute" unchecked -> checked\n$/)
    assert.deepEqual(daemon.requests.map((r) => r.cmd ?? 'dump'), ['dump', 'tap', 'dump', 'change'])
    assert.equal(daemon.requests[3].seq, 7)
  } finally { await daemon.close() }
})
test('a change that lands after the first settle read is still reported', async () => {
  const mute = (checked) => node({ class: 'android.widget.Switch', text: 'Mute', checkable: true, checked })
  const before = { version: 1, windows: [window([mute(false)])], seq: 5 }
  const after = { version: 1, windows: [window([mute(true)])], seq: 8 }
  const daemon = await fakeDaemon(before, { ok: true }, { ...before, seq: 6 }, { seq: 8 }, after, { seq: 8 })
  try {
    const tap = await runWithDaemon(['tap', 'Mute'], daemon.port)
    assert.equal(tap.status, 0, tap.stderr)
    assert.match(tap.stdout, /\nchanged: Switch "Mute" unchecked -> checked\n$/)
  } finally { await daemon.close() }
})
