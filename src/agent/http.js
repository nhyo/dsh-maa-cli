import { createHash } from 'node:crypto'

// Shared, size-limited JSON fetch used by every online data source of the
// plugin (game data, Penguin Statistics, ArkPlanner, the MAA copilot site).
// Keeping one implementation means one timeout, one size cap and one set of
// error messages for all of them.
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

export async function fetchJson(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 运行时不支持 fetch。')
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const init = { signal, headers: { accept: 'application/json', 'user-agent': 'dsh-maa-cli' } }
  if (options.method && options.method !== 'GET') {
    init.method = options.method
    if (options.body !== undefined) {
      init.headers['content-type'] = 'application/json'
      init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
    }
  }
  const response = await fetchImpl(url, init)
  if (!response.ok) throw new Error(`${url} 返回 HTTP ${response.status}`)
  const limit = options.maxBytes ?? MAX_RESPONSE_BYTES
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > limit) throw new Error(`${url} 响应超过安全上限。`)
  const text = await response.text()
  if (Buffer.byteLength(text) > limit) throw new Error(`${url} 响应超过安全上限。`)
  let data
  try { data = JSON.parse(text) } catch { throw new Error(`${url} 返回的不是有效 JSON。`) }
  return {
    url, data,
    etag: response.headers?.get?.('etag') ?? '',
    lastModified: response.headers?.get?.('last-modified') ?? '',
    hash: createHash('sha256').update(text).digest('hex'),
  }
}
