import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { quote } from '../adrive.mjs'

const dir = mkdtempSync(join(tmpdir(), 'adrive-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))
mkdirSync(join(dir, 'helper/build'), { recursive: true })
copyFileSync(new URL('../adrive.mjs', import.meta.url), join(dir, 'adrive.mjs'))
writeFileSync(join(dir, 'helper/build/classes.dex'), 'fixture')
const callsFile = join(dir, 'calls.jsonl')
const bin = join(dir, 'adb')
writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args)+'\\n');
const cmd = args[1] || '';
if (cmd.includes('--serve')) process.stdout.write(process.env.SERVE_PID || '');
else if (cmd.includes('app_process')) process.stdout.write(process.env.DUMP);
else if (args[0] === 'get-serialno') process.stdout.write((process.env.SERIALNO || 'device-1') + '\\n');
else if (cmd.startsWith('kill -0')) process.stdout.write(process.env.ALIVE || '');
else if (args[0] === 'forward' && args[1] === '--list') process.stdout.write(process.env.FORWARD || '');
else if (cmd.includes('md5sum')) process.stdout.write('f16d05ec6b29228d2c61adb1e9263f78  file');
else if (cmd === "'dumpsys' 'window'") process.stdout.write(process.env.FOCUS);
else if (cmd.startsWith('pidof ')) process.stdout.write('1234');
else if (cmd === "'dumpsys' 'media.audio_flinger'") process.stdout.write(process.env.AUDIO || '');
else if (args[0] === 'logcat') process.stdout.write(process.env.LOGS || 'foo.bar match\\nother\\n');
`, { mode: 0o755 })
const node = (fields = {}) => ({ class: 'android.widget.Button', text: 'Delete', desc: '', id: '',
  x: 100, y: 200, left: 50, top: 150, right: 150, bottom: 250, clickable: true, enabled: true, ...fields })
const window = (nodes, id = 1) => ({ id, type: 1, layer: 0, package: 'com.example', nodes })
const environment = (extra) => ({ ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: callsFile,
  DUMP: JSON.stringify({ version: 1, windows: [window([node()])] }),
  FOCUS: 'mCurrentFocus=Window{a u0 com.example/.MainActivity}', ADRIVE_NO_DAEMON: '1', ...extra })
const recorded = () => readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
function run(args, extra = {}) {
  writeFileSync(callsFile, '')
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
  assert.deepEqual(result.calls.at(-1), shellCommand('input', 'tap', 100, 200))
  assert.equal(run(['tap', 'spoof'], { DUMP: JSON.stringify({ version: 1, windows: [window([node({ text: 'Other', desc: 'metadata id=fake' })])] }) }).status, 1)
})
test('signed centers and exact multiline queries survive JSON', () => {
  const result = ok(run(['tap', 'first\nsecond'], { DUMP: JSON.stringify({ version: 1, windows: [window([node({ text: 'first\nsecond', x: -10 })])] }) }))
  assert.deepEqual(result.calls.at(-1), shellCommand('input', 'tap', -10, 200))
})
test('JSON output preserves windows and values; --windows reaches helper', () => {
  const data = { version: 1, windows: [window([node({ text: 'a\nb' })], 2), window([node()], 1)] }
  const result = ok(run(['ui', '--json', '--windows', '--all'], { DUMP: JSON.stringify(data) }))
  assert.deepEqual(JSON.parse(result.stdout), data)
  assert.match(result.calls.at(-1)[1], /Dump --all --windows$/)
  const tap = ok(run(['tap', 'Delete', '--windows', '--nth', '1'], { DUMP: JSON.stringify({ version: 1, windows: [window([node({ x: 10, clickable: false })], 2), window([node({ x: 20 })], 1)] }) }))
  assert.deepEqual(tap.calls.at(-1), shellCommand('input', 'tap', 20, 200))
})
test('literal --nth and %s are typed without option or Android substitution', () => {
  assert.deepEqual(ok(run(['type', '--nth', '2'])).calls, [shellCommand('input', 'text', '--nth%s2')])
  const result = ok(run(['type', 'a %s %%s']))
  assert.deepEqual(result.calls, ['a%s', '%', 's%s', '%', '%', 's'].map(v => shellCommand('input', 'text', v)))
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
    const tap = await runWithDaemon(['tap', 'From daemon'], daemon.port)
    assert.deepEqual(tap.calls, [['forward', '--list'], shellCommand('input', 'tap', 7, 200)])
  } finally { await daemon.close() }
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
