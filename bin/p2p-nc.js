#!/usr/bin/env node

import { main } from '../src/cli.js'

await main()

await Promise.all([
  new Promise(resolve => process.stdout.write('', resolve)),
  new Promise(resolve => process.stderr.write('', resolve))
])

process.exit(process.exitCode ?? 0)
