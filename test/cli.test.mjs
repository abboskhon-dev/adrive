import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
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
if (cmd.includes('app_process')) process.stdout.write(process.env.DUMP);
else if (cmd.includes('md5sum')) process.stdout.write('f16d05ec6b29228d2c61adb1e9263f78  file');
else if (cmd === "'dumpsys' 'window'") process.stdout.write(process.env.FOCUS);
else if (cmd.startsWith('pidof ')) process.stdout.write('1234');
else if (args[0] === 'logcat') process.stdout.write(process.env.LOGS || 'foo.bar match\\nother\\n');
`, { mode: 0o755 })
const node = (fields = {}) => ({ class: 'android.widget.Button', text: 'Delete', desc: '', id: '',
  x: 100, y: 200, left: 50, top: 150, right: 150, bottom: 250, clickable: true, enabled: true, ...fields })
const window = (nodes, id = 1) => ({ id, type: 1, layer: 0, package: 'com.example', nodes })
function run(args, extra = {}) {
  writeFileSync(callsFile, '')
  const result = spawnSync(process.execPath, [join(dir, 'adrive.mjs'), ...args], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: callsFile,
      DUMP: JSON.stringify({ version: 1, windows: [window([node()])] }),
      FOCUS: 'mCurrentFocus=Window{a u0 com.example/.MainActivity}', ...extra }
  })
  const calls = readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  return { ...result, calls }
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
