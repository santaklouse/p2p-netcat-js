import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys'

export function defaultIdentityPath () {
  const configHome = process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config')
  return resolve(configHome, 'p2p-netcat', 'identity.key')
}

export async function loadOrCreateIdentity (filePath) {
  if (filePath == null) {
    return generateKeyPair('Ed25519')
  }

  const absolutePath = resolve(filePath)

  try {
    return privateKeyFromProtobuf(await readFile(absolutePath))
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`Не удалось прочитать ключ ${absolutePath}: ${error.message}`, { cause: error })
    }
  }

  await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 })
  const privateKey = await generateKeyPair('Ed25519')
  await writeFile(absolutePath, privateKeyToProtobuf(privateKey), { mode: 0o600, flag: 'wx' })
  await chmod(absolutePath, 0o600)
  return privateKey
}

