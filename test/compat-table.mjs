#!/usr/bin/env node
// Prints a Markdown table, API level x check, from the compat-<api>/compat.tsv files that test/smoke.sh wrote.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? '.'
if (!existsSync(dir)) { console.log('No emulator results.'); process.exit(0) }
const NAMES = { fixture: 'Views', compose: 'Compose', flutter: 'Flutter', 'react-native': 'React Native' }
const MARK = { pass: '✅', fail: '❌', skip: '–' }

const rows = readdirSync(dir).filter((d) => d.startsWith('compat-')).map((d) => {
  const file = join(dir, d, 'compat.tsv')
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
  return { api: d.slice('compat-'.length).replace(/\.0$/, ''), cells: new Map(lines.map((l) => l.split('\t'))) }
}).sort((a, b) => parseFloat(a.api) - parseFloat(b.api))

const checks = [...new Set(rows.flatMap((r) => [...r.cells.keys()]))]
const out = [
  `| API | ${checks.map((c) => NAMES[c] ?? `\`${c}\``).join(' | ')} |`,
  `|---|${checks.map(() => ':-:|').join('')}`,
  ...rows.map((r) => r.cells.size
    ? `| ${r.api} | ${checks.map((c) => MARK[r.cells.get(c)] ?? '?').join(' | ')} |`
    : `| ${r.api} | did not run${' |'.repeat(checks.length)}`),
]
console.log(out.join('\n'))
