import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

if (process.platform !== 'win32') {
  const require = createRequire(import.meta.url)
  const packageDirectory = dirname(require.resolve('node-pty/package.json'))
  const candidates = [
    join(packageDirectory, 'build', 'Release', 'spawn-helper'),
    join(packageDirectory, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) chmodSync(candidate, 0o755)
  }
}
