import { spawn } from 'node:child_process'
import { isIP } from 'node:net'
import process from 'node:process'

export const TOR_ACTIVE_ENV = 'P2P_NETCAT_TOR_ACTIVE'

function booleanShortOptionRequested (argv, option) {
  return argv.slice(2).some(argument => {
    if (argument === `-${option}`) return true
    if (!/^-[^-]{2,}$/.test(argument)) return false
    if (/^-(?:I|w|d|p|e)/.test(argument)) return false
    return argument.slice(1).includes(option)
  })
}

export function torRequested (argv) {
  return argv.includes('--tor') || booleanShortOptionRequested(argv, 'T')
}

export function quietRequested (argv) {
  return argv.includes('--quiet') || booleanShortOptionRequested(argv, 'q')
}

export function torCommand (argv, env = process.env) {
  const host = env.P2P_NETCAT_TOR_HOST ?? env.GSOCKET_SOCKS_IP ?? '127.0.0.1'
  const portText = env.P2P_NETCAT_TOR_PORT ?? env.GSOCKET_SOCKS_PORT ?? '9050'
  const port = Number(portText)
  if (isIP(host) === 0) throw new Error(`Tor SOCKS host должен быть числовым IP-адресом: ${host}`)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Некорректный Tor SOCKS port: ${portText}`)

  return {
    command: env.P2P_NETCAT_TORSOCKS_COMMAND ?? 'torsocks',
    arguments: [
      ...(quietRequested(argv) ? ['-q'] : []),
      '-i',
      '-a',
      host,
      '-P',
      String(port),
      process.execPath,
      ...argv.slice(1)
    ],
    options: {
      stdio: 'inherit',
      env: { ...env, [TOR_ACTIVE_ENV]: '1' }
    }
  }
}

export async function runUnderTor (argv = process.argv, env = process.env) {
  if (!torRequested(argv) || env[TOR_ACTIVE_ENV] === '1') return false
  if (argv.some(argument => ['-h', '--help', '-V', '--version'].includes(argument))) return false
  if (process.platform === 'win32') {
    throw new Error('Опция -T требует torsocks и сейчас поддерживается на Linux/macOS')
  }

  const config = torCommand(argv, env)
  const child = spawn(config.command, config.arguments, config.options)
  const [code, signal] = await new Promise((resolve, reject) => {
    child.once('error', error => {
      if (error.code === 'ENOENT') {
        reject(new Error(`Не найден ${config.command}. Установите Tor и torsocks для использования -T.`))
      } else {
        reject(error)
      }
    })
    child.once('exit', (code, signal) => resolve([code, signal]))
  })

  if (signal != null) process.kill(process.pid, signal)
  process.exitCode = code ?? 1
  return true
}
