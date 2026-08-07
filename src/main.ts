import * as crypto from 'crypto'
import { RegisterServerOptions } from '@peertube/peertube-types'

const TIMEOUT_MS = 30000
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

interface TesseraPluginData {
  'tessera-mode'?: string
  'tessera-rate'?: string
  'tessera-wallet'?: string
  'tessera-tip-amount'?: string
}

function extractTesseraPluginData (pluginData: unknown): TesseraPluginData {
  if (!pluginData) return {}
  let pData: unknown = pluginData
  if (typeof pData === 'string') {
    try { pData = JSON.parse(pData) } catch { return {} }
  }
  if (typeof pData !== 'object' || pData === null) return {}

  const record = pData as Record<string, unknown>
  if (typeof record['tessera-wallet'] === 'string' || typeof record['tessera-mode'] === 'string') {
    return record as TesseraPluginData
  }

  for (const ns of ['peertube-plugin-tessera', 'tessera']) {
    const nested = record[ns]
    if (nested && typeof nested === 'object') {
      return nested as TesseraPluginData
    }
  }

  return record as TesseraPluginData
}

function storageKey (field: keyof TesseraPluginData, videoId: number): string {
  return `${field}-${videoId}`
}

async function persistTesseraVideoData (
  storageManager: { storeData: (key: string, data: unknown) => Promise<unknown> },
  videoId: number,
  data: TesseraPluginData
): Promise<void> {
  if (data['tessera-wallet'] !== undefined) {
    await storageManager.storeData(storageKey('tessera-wallet', videoId), data['tessera-wallet'].trim())
  }
  if (data['tessera-mode'] !== undefined) {
    await storageManager.storeData(storageKey('tessera-mode', videoId), data['tessera-mode'])
  }
  if (data['tessera-rate'] !== undefined) {
    await storageManager.storeData(storageKey('tessera-rate', videoId), data['tessera-rate'])
  }
  if (data['tessera-tip-amount'] !== undefined) {
    await storageManager.storeData(storageKey('tessera-tip-amount', videoId), data['tessera-tip-amount'])
  }
}

async function loadTesseraVideoData (
  storageManager: { getData: <T = unknown>(key: string) => Promise<T | undefined> },
  videoId: number,
  pluginData?: unknown
): Promise<TesseraPluginData> {
  const fromRequest = extractTesseraPluginData(pluginData)
  const [wallet, mode, rate, tipAmount] = await Promise.all([
    storageManager.getData<string>(storageKey('tessera-wallet', videoId)),
    storageManager.getData<string>(storageKey('tessera-mode', videoId)),
    storageManager.getData<string>(storageKey('tessera-rate', videoId)),
    storageManager.getData<string>(storageKey('tessera-tip-amount', videoId)),
  ])

  return {
    'tessera-wallet': fromRequest['tessera-wallet'] || wallet,
    'tessera-mode': fromRequest['tessera-mode'] || mode,
    'tessera-rate': fromRequest['tessera-rate'] || rate,
    'tessera-tip-amount': fromRequest['tessera-tip-amount'] || tipAmount,
  }
}

function validateTesseraWallet (pluginData: unknown): string | null {
  const data = extractTesseraPluginData(pluginData)
  const mode = data['tessera-mode'] || 'pay-per-second'
  // Free mode (with optional tips) does not require a wallet or rate
  if (mode === 'free') return null

  const wallet = (data['tessera-wallet'] || '').trim()
  if (!wallet) {
    return 'Creator wallet address is required for pay-per-second monetization.'
  }
  if (!EVM_ADDRESS_RE.test(wallet)) {
    return 'Creator wallet must be a valid Arc Network address (0x…).'
  }

  // Robust validation of rate per second
  const rateStr = data['tessera-rate']
  if (rateStr === undefined || rateStr === null || rateStr === '') {
    return 'Rate per second is required for pay-per-second monetization.'
  }
  const rate = Number(rateStr)
  if (isNaN(rate) || rate < 0.000001 || rate > 0.01) {
    return 'Rate per second must be a number between 0.000001 and 0.01 USDC.'
  }
  return null
}

/** Locality for federation: where the video was published vs where the viewer watches. */
function resolveVideoLocality (
  video: { isLocal?: boolean; url?: string } | null | undefined,
  localWebserverUrl: string
): { isLocal: boolean, originInstanceUrl: string } {
  const isLocal = video?.isLocal !== false
  let originInstanceUrl = localWebserverUrl
  if (!isLocal && video?.url) {
    try {
      originInstanceUrl = new URL(video.url).origin
    } catch {
      // Keep local webserver URL as fallback
    }
  }
  return { isLocal, originInstanceUrl }
}

async function resolveRemotePluginRouterBase (originInstanceUrl: string): Promise<string | null> {
  try {
    const pluginInfoRes = await fetch(
      `${originInstanceUrl}/api/v1/plugins/peertube-plugin-tessera`,
      { signal: AbortSignal.timeout(3000) }
    )
    if (!pluginInfoRes.ok) return null

    const pluginInfo = await pluginInfoRes.json() as { plugin?: { version?: string }, version?: string }
    const version = pluginInfo?.plugin?.version ?? pluginInfo?.version
    if (!version) return null

    return `${originInstanceUrl}/plugins/peertube-plugin-tessera/${version}/router`
  } catch {
    return null
  }
}

/**
 * Federated videos do not carry tessera-* pluginData over ActivityPub.
 * Fetch monetization fields from the origin instance Tessera plugin.
 */
async function fetchRemoteTesseraData (
  originInstanceUrl: string,
  videoUuid: string
): Promise<TesseraPluginData | null> {
  const routerBase = await resolveRemotePluginRouterBase(originInstanceUrl)
  if (!routerBase) return null

  try {
    const res = await fetch(
      `${routerBase}/video/${encodeURIComponent(videoUuid)}/tessera-data`,
      { signal: AbortSignal.timeout(5000) }
    )
    if (!res.ok) return null

    const data = await res.json() as {
      wallet?: string | null
      mode?: string | null
      rate?: string | null
      tipAmount?: string | null
    }

    return {
      'tessera-wallet': data.wallet || undefined,
      'tessera-mode': data.mode || undefined,
      'tessera-rate': data.rate || undefined,
      'tessera-tip-amount': data.tipAmount || undefined,
    }
  } catch {
    return null
  }
}

async function resolveTesseraMonetizationForVideo (
  storageManager: { getData: <T = unknown>(key: string) => Promise<T | undefined> },
  video: { id?: number; uuid?: string; isLocal?: boolean; url?: string; pluginData?: unknown },
  localWebserverUrl: string
): Promise<{ data: TesseraPluginData, isLocal: boolean, originInstanceUrl: string }> {
  const { isLocal, originInstanceUrl } = resolveVideoLocality(video, localWebserverUrl)
  let data: TesseraPluginData = {}

  if (video.id) {
    data = await loadTesseraVideoData(storageManager, video.id, video.pluginData)
  } else {
    data = extractTesseraPluginData(video.pluginData)
  }

  const needsRemoteLookup = !isLocal && (
    !data['tessera-wallet'] ||
    !data['tessera-mode'] ||
    !data['tessera-rate']
  )

  if (needsRemoteLookup && video.uuid && originInstanceUrl !== localWebserverUrl) {
    const remote = await fetchRemoteTesseraData(originInstanceUrl, video.uuid)
    if (remote) {
      data = {
        'tessera-wallet': data['tessera-wallet'] || remote['tessera-wallet'],
        'tessera-mode': data['tessera-mode'] || remote['tessera-mode'],
        'tessera-rate': data['tessera-rate'] || remote['tessera-rate'],
        'tessera-tip-amount': data['tessera-tip-amount'] || remote['tessera-tip-amount'],
      }
    }
  }

  return { data, isLocal, originInstanceUrl }
}

interface ViewerSession {
  expireTime: number
  lastAccessTime: number
  payload: any
  pendingAction?: 'stop' | null
}

const activeViewers = new Map<string, ViewerSession>()
const actionQueues = new Map<string, Promise<any>>()

const enqueueAction = async (userId: string, action: () => Promise<any>): Promise<any> => {
    const currentQueue = actionQueues.get(userId) || Promise.resolve()
    const newQueue = currentQueue.then(action, action)
    actionQueues.set(userId, newQueue)
    
    newQueue.finally(() => {
        if (actionQueues.get(userId) === newQueue) actionQueues.delete(userId)
    })
    
    return newQueue
}

export async function register (options: RegisterServerOptions) {
  const { registerSetting, settingsManager, getRouter, peertubeHelpers, registerHook, storageManager } = options

  // 5.2: Cache base URL to prevent abuse
  let cachedBaseUrl: string | null = null
  let baseUrlCacheTime = 0

  const getBaseUrl = async (): Promise<string | null> => {
    if (cachedBaseUrl && Date.now() - baseUrlCacheTime < 60000) {
       return cachedBaseUrl
    }
    const webhookUrl = await settingsManager.getSetting('webhook-url') as string
    if (!webhookUrl) return null
    try {
      cachedBaseUrl = new URL(webhookUrl).origin
      baseUrlCacheTime = Date.now()
      return cachedBaseUrl
    } catch {
      return null
    }
  }

  // 5.1: Rate limiting Map
  const pingRateLimits = new Map<string, number>()

  // 3.1: Helper to get MAX_CACHE_SIZE
  const getMaxActiveViewers = async (): Promise<number> => {
    const max = await settingsManager.getSetting('max-active-viewers') as string
    return parseInt(max, 10) || 10000
  }

  // Helper to send the signed webhook
  // 3.3: Return boolean to indicate success
  const sendWebhook = async (event: 'viewer_joined' | 'viewer_left', payloadData: any, maxRetries = 3): Promise<boolean> => {
    const webhookUrl = await settingsManager.getSetting('webhook-url') as string
    const webhookSecret = await settingsManager.getSetting('webhook-secret') as string

    if (!webhookUrl || !webhookSecret) {
      peertubeHelpers.logger.warn('[tessera] Webhook not sent: Plugin configuration missing.')
      return false
    }

    // Tessera flat connector HMAC (verifyConnectorSignature):
    // headers X-Tessera-Timestamp / X-Tessera-Nonce / X-Tessera-Signature
    // signature = HMAC-SHA256(secret, `${timestamp}.${nonce}.${rawBody}`)
    // webhook-secret setting must equal TESSERA_CONNECTOR_SECRET_PEERTUBE on the sidecar.
    const timestamp = String(Date.now())
    const nonce = crypto.randomBytes(16).toString('hex')
    const payload = JSON.stringify({ event, timestamp: Number(timestamp), nonce, ...payloadData })
    const signature = crypto
      .createHmac('sha256', webhookSecret)
      .update(`${timestamp}.${nonce}.${payload}`)
      .digest('hex')

    for (let i = 0; i < maxRetries; i++) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10000)

        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Tessera-Timestamp': timestamp,
            'X-Tessera-Nonce': nonce,
            'X-Tessera-Signature': signature
          },
          body: payload,
          signal: controller.signal
        })
        clearTimeout(timeout)
        
        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(`Rejected: ${response.status} ${errorText}`)
        }

        peertubeHelpers.logger.info(`[tessera] Webhook '${event}' sent for user ${payloadData.userId}.`)
        return true
      } catch (err) {
        if (i === maxRetries - 1) {
          peertubeHelpers.logger.error(`[tessera] Error sending webhook after ${maxRetries} attempts: ${err}`)
          return false
        }
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)))
      }
    }
    return false
  }

  // Global checker for inactive viewers
  setInterval(() => {
    const now = Date.now()
    for (const [userId, session] of activeViewers.entries()) {
      if (now > session.expireTime && session.pendingAction !== 'stop') {
        // 3.4: Fix ghost sessions (await viewer_left before deletion)
        // Add a small buffer to expireTime to avoid spamming retries every 5s if sidecar is down.
        // We temporarily bump the expireTime to avoid multiple concurrent requests.
        session.pendingAction = 'stop'
        session.expireTime = now + 15000 
        
        sendWebhook('viewer_left', session.payload).then(success => {
           if (success) {
             activeViewers.delete(userId)
           } else {
             session.pendingAction = null
           }
        })
      }
    }

    // Clean up rate limits
    for (const [userId, lastPing] of pingRateLimits.entries()) {
      if (now - lastPing > 60000) {
        pingRateLimits.delete(userId)
      }
    }
  }, 5000)

  // 1. Register settings for Tessera integration
  await registerSetting({
    name: 'tessera-base-url',
    label: 'Tessera Base URL',
    type: 'input',
    descriptionHTML: 'The public URL of your Tessera backend (e.g. https://tessera.try-tessera.xyz)',
    default: '',
    private: false
  })

  await registerSetting({
    name: 'webhook-url',
    label: 'Tessera Webhook URL',
    type: 'input',
    descriptionHTML: 'The URL to send events (e.g. https://your-tessera.com/api/connectors/peertube/webhook)',
    default: '',
    private: true
  })

  await registerSetting({
    name: 'webhook-secret',
    label: 'Tessera Webhook Secret',
    type: 'input',
    descriptionHTML: 'Must match the sidecar env <code>TESSERA_CONNECTOR_SECRET_PEERTUBE</code>. Used for Tessera HMAC headers (X-Tessera-Timestamp / Nonce / Signature) and admin Bearer auth.',
    default: '',
    private: true
  })

  await registerSetting({
    name: 'max-active-viewers',
    label: 'Max Active Viewers',
    type: 'input',
    descriptionHTML: 'Maximum number of concurrent active viewers allowed in memory to prevent exhaustion.',
    default: '10000',
    private: false
  })

  await registerSetting({
    name: 'admin-wallet-address',
    label: 'Admin Wallet (Arc Network)',
    type: 'input',
    descriptionHTML: 'Platform admin wallet address for receiving commission. Withdrawals are executed no-custodially via MetaMask.',
    default: '',
    private: false
  })

  await registerSetting({
    name: 'tessera-display-fee',
    label: 'Display Fee (Platform Commission)',
    type: 'select',
    options: [
      { label: '0%', value: '0.00' },
      { label: '10%', value: '0.10' },
      { label: '20%', value: '0.20' },
      { label: '30%', value: '0.30' }
    ],
    default: '0.10',
    descriptionHTML: 'The commission percentage charged to creators when viewers watch videos directly on this instance.',
    private: false
  })

  await registerSetting({
    name: 'tessera-origin-fee',
    label: 'Origin Fee (Hosting Commission)',
    type: 'select',
    options: [
      { label: '0%', value: '0.00' },
      { label: '10%', value: '0.10' },
      { label: '20%', value: '0.20' },
      { label: '30%', value: '0.30' }
    ],
    default: '0.10',
    descriptionHTML: 'The commission percentage charged to creators when viewers watch videos federated from this instance on another platform.',
    private: false
  })


  const rejectUploadIfWalletInvalid = (result: any, params?: any) => {
    // Some hooks might pass req inside params
    const req = params?.req
    const pluginData = req?.body?.pluginData || req?.body?.pluginDataString

    // If no pluginData is present, this is a raw file upload (chunked upload phase).
    // The wallet is not available yet at this stage — the creator sets it during
    // the publish form step. Allow the upload and defer validation to the
    // action:api.video.uploaded / action:api.video.updated hooks.
    if (!pluginData) {
      return result || { allowed: true }
    }

    const error = validateTesseraWallet(pluginData)
    if (error) {
      peertubeHelpers.logger.warn(`[tessera] Upload rejected: ${error}`)
      return {
        allowed: false,
        errorMessage: error
      }
    }
    return result || { allowed: true }
  }

  registerHook({
    target: 'filter:api.video.upload.accept.result',
    handler: rejectUploadIfWalletInvalid as any
  })

  registerHook({
    target: 'filter:api.video.pre-import-url.accept.result',
    handler: rejectUploadIfWalletInvalid as any
  })

  registerHook({
    target: 'filter:api.video.pre-import-torrent.accept.result',
    handler: rejectUploadIfWalletInvalid as any
  })

  registerHook({
    target: 'filter:api.video.post-import-url.accept.result',
    handler: rejectUploadIfWalletInvalid as any
  })

  registerHook({
    target: 'filter:api.video.post-import-torrent.accept.result',
    handler: rejectUploadIfWalletInvalid as any
  })

  const syncTesseraVideoData = async (video: { id?: number }, req?: { body?: { pluginData?: unknown; pluginDataString?: unknown } }) => {
    if (!video?.id) return
    const pluginData = req?.body?.pluginData || req?.body?.pluginDataString
    const data = extractTesseraPluginData(pluginData)
    if (data['tessera-wallet'] !== undefined || data['tessera-mode'] !== undefined || data['tessera-rate'] !== undefined || data['tessera-tip-amount'] !== undefined) {
      await persistTesseraVideoData(storageManager, video.id, data)
    }
  }

  registerHook({
    target: 'action:api.video.uploaded',
    handler: (({ video, req }: { video?: { id?: number }; req?: { body?: { pluginData?: unknown } } }) => {
      return syncTesseraVideoData(video || {}, req)
    }) as () => unknown
  })

  registerHook({
    target: 'action:api.video.updated',
    handler: (({ video, req }: { video?: { id?: number }; req?: { body?: { pluginData?: unknown } } }) => {
      return syncTesseraVideoData(video || {}, req)
    }) as () => unknown
  })

  registerHook({
    target: 'filter:api.video.get.result',
    handler: (async (video: { id?: number; pluginData?: Record<string, unknown> }) => {
      if (!video?.id) return video

      const fromApi = extractTesseraPluginData(video.pluginData)
      if (fromApi['tessera-wallet'] || fromApi['tessera-mode'] || fromApi['tessera-rate'] || fromApi['tessera-tip-amount']) {
        await persistTesseraVideoData(storageManager, video.id, fromApi)
      }

      const stored = await loadTesseraVideoData(storageManager, video.id, video.pluginData)
      if (stored['tessera-wallet'] || stored['tessera-mode'] || stored['tessera-rate'] || stored['tessera-tip-amount']) {
        if (!video.pluginData) video.pluginData = {}
        if (stored['tessera-wallet']) video.pluginData['tessera-wallet'] = stored['tessera-wallet']
        if (stored['tessera-mode']) video.pluginData['tessera-mode'] = stored['tessera-mode']
        if (stored['tessera-rate']) video.pluginData['tessera-rate'] = stored['tessera-rate']
        if (stored['tessera-tip-amount']) video.pluginData['tessera-tip-amount'] = stored['tessera-tip-amount']
      }

      if (stored['tessera-mode'] === 'pay-per-second') {
        try {
          const v = video as Record<string, any>
          const uuid = v['uuid']
          const webserverUrl = peertubeHelpers.config.getWebserverUrl()
          if (webserverUrl && uuid) {
            v['embedUrl'] = `${webserverUrl}/videos/embed/${uuid}`
            v['embedPath'] = `/videos/embed/${uuid}`

            const proxyBase = `${webserverUrl}/plugins/peertube-plugin-tessera/router/hls-proxy/${uuid}`
            if (Array.isArray(v['streamingPlaylists']) && v['streamingPlaylists'].length > 0) {
              v['streamingPlaylists'] = v['streamingPlaylists'].map((sp: any) => ({
                ...sp,
                playlistUrl: `${proxyBase}/master.m3u8`
              }))
            }
            v['files'] = []
          }
        } catch {
          // ignore webserverUrl lookup errors
        }
      }

      return video
    }) as () => unknown
  })

  // Hook: rewrite HLS playlist URL in ActivityPub JSON-LD so federated instances
  // store our proxy URL instead of the real static HLS URL.
  // When Instance B's player requests the manifest, it hits our router where
  // we enforce the 5-second teaser for unauthenticated sessions.
  registerHook({
    target: 'filter:activity-pub.video.json-ld.build.result' as any,
    handler: (async (jsonld: any, params: { video: { id?: number; uuid?: string; pluginData?: Record<string, unknown> } }) => {
      if (!jsonld || !params?.video?.id || !params?.video?.uuid) return jsonld

      const stored = await loadTesseraVideoData(storageManager, params.video.id, params.video.pluginData)
      if (stored['tessera-mode'] !== 'pay-per-second') return jsonld

      const webserverUrl = peertubeHelpers.config.getWebserverUrl()
      if (!webserverUrl) return jsonld

      // peertubeHelpers.plugin.getBaseRouterRoute() returns the correct URL like
      // '/plugins/tessera/router/' (PeerTube prepends 'peertube-plugin-' internally,
      // so the URL segment must NOT include the 'peertube-plugin-' prefix).
      const baseRouterRoute = peertubeHelpers.plugin.getBaseRouterRoute().replace(/\/$/, '')
      const proxyBase = `${webserverUrl}${baseRouterRoute}/hls-proxy/${params.video.uuid}`

      // For pay-per-second videos, rewrite the HLS playlist URL to our proxy
      // and strip all direct-playable formats so federated players cannot bypass
      // the teaser by using MP4/WebM downloads or BitTorrent.
      // Non-playback URLs (captions, segment hashes, trackers) are preserved.
      const DIRECT_PLAYABLE_TYPES = new Set([
        'video/mp4',
        'video/webm',
        'video/ogg',
        'audio/mp4',
        'application/x-bittorrent',
        'application/x-bittorrent;x-scheme-handler/magnet',
      ])

      if (Array.isArray(jsonld.url)) {
        jsonld.url = jsonld.url
          // Strip direct-playable files so the player must use HLS
          .filter((u: any) => !DIRECT_PLAYABLE_TYPES.has(u?.mediaType))
          // Rewrite HLS playlist URL to our teaser proxy (/manifest?file=...)
          .map((u: any) => {
            if (u?.mediaType === 'application/x-mpegURL' && typeof u?.href === 'string') {
              const filename = u.href.split('/').pop() ?? 'master.m3u8'
              return { ...u, href: `${proxyBase}/${filename}` }
            }
            return u
          })
      }

      peertubeHelpers.logger.info(`[tessera] ActivityPub JSON-LD: rewrote HLS URL for video ${params.video.uuid}`)
      return jsonld
    }) as () => unknown
  })

  // 2. Set up internal router
  const router = getRouter()

  const loadVideoWithFallback = async (idOrUuid: string): Promise<any> => {
    try {
      return await peertubeHelpers.videos.loadByIdOrUUID(idOrUuid)
    } catch (err) {
      try {
        const localUrl = peertubeHelpers.config.getWebserverUrl()
        const apiRes = await fetch(`${localUrl}/api/v1/videos/${encodeURIComponent(idOrUuid)}`)
        if (apiRes.ok) {
          const video = await apiRes.json()
          return video
        }
      } catch (fallbackErr) {
        peertubeHelpers.logger.warn(`[tessera] Local API fallback failed for ${idOrUuid}: ${fallbackErr}`)
      }
      throw err
    }
  }

  // Endpoint for the client script to retrieve the base URL and current instance fees
  router.get('/base-url', async (req: any, res: any) => {
    let baseUrl = await getBaseUrl()
    if (!baseUrl) {
      return res.status(404).json({ error: 'Plugin not fully configured' })
    }
    if (baseUrl.includes('host.docker.internal')) {
      baseUrl = baseUrl.replace('host.docker.internal', 'localhost')
    }

    const displayFeeStr = await settingsManager.getSetting('tessera-display-fee') as string || '0.10'
    const originFeeStr = await settingsManager.getSetting('tessera-origin-fee') as string || '0.10'

    res.json({
      baseUrl,
      displayFee: parseFloat(displayFeeStr),
      originFee: parseFloat(originFeeStr)
    })
  })

  // ─── HLS Proxy Routes ──────────────────────────────────────────────────────
  // Serves HLS manifests for federated/local viewers.
  // Uses router.get (not router.use) because router.get is empirically confirmed to
  // reach the handler in PeerTube's plugin router (router.use does not).
  // Master playlists (#EXT-X-STREAM-INF) → rewrite variant URLs to go through this proxy.
  // Variant playlists (#EXTINF:) → truncate to HLS_TEASER_SECONDS for non-paying viewers.

  const HLS_TEASER_SECONDS = 5


  router.get('/hls-proxy/:videoUuid/:playlistFile', async (req: any, res: any) => {
    // Set CORS headers immediately for all GET responses
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD')
    res.set('Access-Control-Allow-Headers', 'Content-Type, Range, x-tessera-session')

    const videoUuid = req.params.videoUuid as string
    const playlistFile = req.params.playlistFile as string

    peertubeHelpers.logger.info(`[tessera] HLS proxy request: method=${req.method}, video=${videoUuid}, file=${playlistFile}, path=${req.path}`)

    const webserverUrl = peertubeHelpers.config.getWebserverUrl()
    if (!webserverUrl) return res.status(500).json({ error: 'Server not configured' })

    const isPaidSession = false

    try {
      let content: string | null = null

      // Primary: obtain official disk path via PeerTube's native helper and scan directory
      try {
        const filesInfo = await peertubeHelpers.videos.getFiles(videoUuid)
        const hlsInfo = (filesInfo as any)?.hls
        const baseHlsPath = hlsInfo?.masterPlaylistPath || hlsInfo?.playlistPath

        if (baseHlsPath) {
          const { promises: fsPromises } = await import('fs')
          const { dirname, join } = await import('path')
          const dir = dirname(baseHlsPath)
          const files = await fsPromises.readdir(dir)

          let matchedFile: string | undefined
          if (playlistFile.endsWith('master.m3u8') || playlistFile === 'master.m3u8') {
            matchedFile = files.find(f => f.endsWith('-master.m3u8') || f === 'master.m3u8')
          } else {
            matchedFile = files.find(f => f === playlistFile || f.endsWith(playlistFile))
          }

          if (matchedFile) {
            content = await fsPromises.readFile(join(dir, matchedFile), 'utf8')
          }
        }
      } catch (fileErr: any) {
        peertubeHelpers.logger.warn(`[tessera] getFiles lookup failed for ${videoUuid}/${playlistFile}: ${fileErr.message}`)
      }

      // Fallback A: direct container disk path
      if (!content) {
        try {
          const { promises: fsPromises } = await import('fs')
          const diskPath = `/data/streaming-playlists/hls/${videoUuid}/${playlistFile}`
          content = await fsPromises.readFile(diskPath, 'utf8')
        } catch {
          // ignore
        }
      }

      // Fallback B: HTTP fetch via webserverUrl
      if (!content) {
        try {
          const realUrl = `${webserverUrl}/static/streaming-playlists/hls/${videoUuid}/${playlistFile}`
          const response = await fetch(realUrl, { signal: AbortSignal.timeout(8000) })
          if (response.ok) {
            content = await response.text()
          }
        } catch {
          // ignore
        }
      }

      if (!content) {
        peertubeHelpers.logger.error(`[tessera] HLS proxy playlist not found for video ${videoUuid}, file ${playlistFile}`)
        return res.status(404).end()
      }

      const baseRouterRoute = peertubeHelpers.plugin.getBaseRouterRoute().replace(/\/$/, '')
      const proxyBase = `${webserverUrl}${baseRouterRoute}/hls-proxy/${videoUuid}`

      // Case A: Master Playlist (contains variant stream definitions)
      if (content.includes('#EXT-X-STREAM-INF') || playlistFile.endsWith('master.m3u8')) {
        const rewritten = content.replace(
          /^(?!#)([^\s]+\.m3u8.*)$/gm,
          (line) => `${proxyBase}/${line.trim()}`
        )
        res.set('Content-Type', 'application/vnd.apple.mpegurl')
        res.set('Cache-Control', 'no-cache')
        return res.send(rewritten)
      }

      // Case B: Variant Playlist (contains segment .ts / fMP4 files)
      const staticBase = `${webserverUrl}/static/streaming-playlists/hls/${videoUuid}`
      const absoluteContent = content
        .replace(/URI="([^"]+)"/g, (_: string, uri: string) => {
          if (uri.startsWith('http')) return `URI="${uri}"`
          return `URI="${staticBase}/${uri}"`
        })
        .replace(/^(?!#)([^\s]+\.(?:ts|mp4|m4s).*)$/gm, (seg: string) => {
          if (seg.trim().startsWith('http')) return seg.trim()
          return `${staticBase}/${seg.trim()}`
        })

      if (isPaidSession) {
        res.set('Content-Type', 'application/vnd.apple.mpegurl')
        res.set('Cache-Control', 'no-cache')
        return res.send(absoluteContent)
      }

      // Teaser: emit segments up to HLS_TEASER_SECONDS then append EXT-X-ENDLIST
      const lines = absoluteContent.split('\n')
      const teaserLines: string[] = []
      let elapsed = 0
      let i = 0
      let teaserEnded = false

      while (i < lines.length) {
        const line = lines[i].trimEnd()

        if (teaserEnded) {
          i++
          continue
        }

        if (line.startsWith('#EXTINF:')) {
          const segDuration = parseFloat(line.replace('#EXTINF:', '').replace(',', ''))
          if (elapsed >= HLS_TEASER_SECONDS) {
            teaserLines.push('#EXT-X-ENDLIST')
            teaserEnded = true
            i++
            continue
          }
          teaserLines.push(line)
          elapsed += segDuration
        } else if (!line.startsWith('#') && line.trim() !== '' && !line.startsWith('http')) {
          i++
          continue
        } else {
          teaserLines.push(line)
        }
        i++
      }

      if (!teaserEnded && !teaserLines.includes('#EXT-X-ENDLIST')) {
        teaserLines.push('#EXT-X-ENDLIST')
      }

      res.set('Content-Type', 'application/vnd.apple.mpegurl')
      res.set('Cache-Control', 'no-cache')
      return res.send(teaserLines.join('\n'))
    } catch (err: any) {
      peertubeHelpers.logger.error(`[tessera] HLS proxy error (${videoUuid}/${playlistFile}): ${err.message}`)
      return res.status(502).end()
    }
  })

  // ─── Browser relay routes ──────────────────────────────────────────────────
  // These routes allow the browser to call the Tessera sidecar through PeerTube's
  // plugin router, eliminating the need for a publicly accessible sidecar URL.
  // All requests are forwarded to the internal sidecar via getBaseUrl().

  // Relay: serve static assets (paywall.bundle.js, paywall.css, logo_yellow.svg, etc.) from the sidecar
  router.get('/assets/:filename', async (req: any, res: any) => {
    const internalUrl = await getBaseUrl()
    if (!internalUrl) return res.status(503).json({ error: 'Sidecar not configured' })
    const filename = req.params.filename as string
    try {
      const response = await fetch(`${internalUrl}/peertube-assets/${encodeURIComponent(filename)}`, {
        signal: AbortSignal.timeout(10000)
      })
      if (!response.ok) return res.status(response.status).send('Failed to fetch asset from sidecar')

      let contentType = 'application/octet-stream'
      if (filename.endsWith('.js')) {
        contentType = 'application/javascript; charset=utf-8'
      } else if (filename.endsWith('.css')) {
        contentType = 'text/css; charset=utf-8'
      } else if (filename.endsWith('.svg')) {
        contentType = 'image/svg+xml'
      } else if (filename.endsWith('.png')) {
        contentType = 'image/png'
      } else if (filename.endsWith('.ico')) {
        contentType = 'image/x-icon'
      }

      const arrayBuffer = await response.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      res.set('Content-Type', contentType)
      res.set('Cache-Control', 'public, max-age=300')
      return res.send(buffer)
    } catch (err: any) {
      peertubeHelpers.logger.error(`[tessera] Asset relay error (${filename}): ${err.message}`)
      return res.status(502).json({ error: 'Could not reach Tessera sidecar' })
    }
  })

  // Relay: forward all /api/core/* requests from the browser to the sidecar.
  // This covers: register-session, recover-session, session-balance, tip, tip-access,
  // top-up, wallet-balance, stream-access, and all /circle/* sub-routes.
  router.all('/api/core/*', async (req: any, res: any) => {
    const internalUrl = await getBaseUrl()
    if (!internalUrl) return res.status(503).json({ error: 'Sidecar not configured' })

    try {
      const qs = Object.keys(req.query).length > 0
        ? '?' + new URLSearchParams(req.query as Record<string, string>).toString()
        : ''
      const targetUrl = `${internalUrl}${req.path}${qs}`
      const isReadOnly = ['GET', 'HEAD'].includes((req.method as string).toUpperCase())

      const response = await fetch(targetUrl, {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        body: isReadOnly ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })

      const data = await response.json()
      return res.status(response.status).json(data)
    } catch (err: any) {
      peertubeHelpers.logger.error(`[tessera] Core API relay error (${req.path}): ${err.message}`)
      return res.status(502).json({ error: 'Could not reach Tessera sidecar' })
    }
  })

  // Relay: expose sidecar instance-info through PeerTube's plugin URL for federation discovery.
  // Remote PeerTube servers can query:
  //   GET https://peertube.remote.com/plugins/peertube-plugin-tessera/{version}/router/instance-info
  // to obtain the admin wallet and fee configuration of the origin instance,
  // without needing the sidecar to have a public URL.
  router.get('/instance-info', async (req: any, res: any) => {
    const internalUrl = await getBaseUrl()
    if (!internalUrl) return res.status(503).json({ error: 'Sidecar not configured' })
    try {
      const response = await fetch(`${internalUrl}/api/tessera/instance-info`, {
        signal: AbortSignal.timeout(5000)
      })
      const data = await response.json()
      return res.status(response.status).json(data)
    } catch (err: any) {
      peertubeHelpers.logger.error(`[tessera] instance-info relay error: ${err.message}`)
      return res.status(502).json({ error: 'Could not reach Tessera sidecar' })
    }
  })

  // ──────────────────────────────────────────────────────────────────────────


  router.get('/video/:id/tessera-data', async (req: any, res: any) => {
    const videoId = req.params.id
    try {
      const video = await loadVideoWithFallback(videoId) as {
        id?: number
        uuid?: string
        isLocal?: boolean
        url?: string
        pluginData?: unknown
      }
      if (!video?.id) return res.status(404).json({ error: 'Video not found' })

      const localWebserverUrl = peertubeHelpers.config.getWebserverUrl()
      const { data, isLocal, originInstanceUrl } = await resolveTesseraMonetizationForVideo(
        storageManager,
        video,
        localWebserverUrl
      )

      res.json({
        wallet: data['tessera-wallet'] || null,
        mode: data['tessera-mode'] || null,
        rate: data['tessera-rate'] || null,
        tipAmount: data['tessera-tip-amount'] || null,
        isLocal,
        originInstanceUrl,
      })
    } catch (err) {
      peertubeHelpers.logger.warn(`[tessera] Error fetching video data for ${videoId}: ${err}`)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // Endpoint for the frontend to fetch the configured admin wallet (for the admin panel)
  router.get('/admin/wallet', async (req: any, res: any) => {
    const wallet = await settingsManager.getSetting('admin-wallet-address') as string;
    res.json({ wallet: wallet || null });
  })

  // Relay endpoint to forward the platform admin's balance queries to the sidecar
  router.get('/admin/balance', async (req: any, res: any) => {
    try {
      const user = await peertubeHelpers.user.getAuthUser(res)
      const roleId = typeof user?.role === 'object' ? (user.role as any).id : user?.role
      if (!user || roleId !== 0) {
        return res.status(401).json({ error: 'Unauthorized: Admin only' })
      }

      const baseUrl = await getBaseUrl()
      if (!baseUrl) return res.status(500).json({ error: 'Base URL not configured' })

      const secret = await settingsManager.getSetting('webhook-secret') as string
      const response = await fetch(`${baseUrl}/api/connectors/peertube/admin/balance`, {
        headers: {
          'Authorization': `Bearer ${secret}`
        }
      })
      const data = await response.json()
      return res.status(response.status).json(data)
    } catch (err: any) {
      return res.status(500).json({ error: err.message })
    }
  })

  // Relay endpoint to prepare platform admin withdrawal requests
  router.post('/admin/prepare-withdraw', async (req: any, res: any) => {
    try {
      const user = await peertubeHelpers.user.getAuthUser(res)
      const roleId = typeof user?.role === 'object' ? (user.role as any).id : user?.role
      if (!user || roleId !== 0) {
        return res.status(401).json({ error: 'Unauthorized: Admin only' })
      }

      const baseUrl = await getBaseUrl()
      if (!baseUrl) return res.status(500).json({ error: 'Base URL not configured' })

      const secret = await settingsManager.getSetting('webhook-secret') as string
      const response = await fetch(`${baseUrl}/api/connectors/peertube/admin/prepare-withdraw`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${secret}`
        }
      })
      const data = await response.json()
      return res.status(response.status).json(data)
    } catch (err: any) {
      return res.status(500).json({ error: err.message })
    }
  })

  // Relay endpoint to complete platform admin withdrawal requests
  router.post('/admin/complete-withdraw', async (req: any, res: any) => {
    try {
      const user = await peertubeHelpers.user.getAuthUser(res)
      const roleId = typeof user?.role === 'object' ? (user.role as any).id : user?.role
      if (!user || roleId !== 0) {
        return res.status(401).json({ error: 'Unauthorized: Admin only' })
      }

      const baseUrl = await getBaseUrl()
      if (!baseUrl) return res.status(500).json({ error: 'Base URL not configured' })

      const secret = await settingsManager.getSetting('webhook-secret') as string
      const response = await fetch(`${baseUrl}/api/connectors/peertube/admin/complete-withdraw`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${secret}`
        },
        body: JSON.stringify(req.body)
      })
      const data = await response.json()
      return res.status(response.status).json(data)
    } catch (err: any) {
      return res.status(500).json({ error: err.message })
    }
  })

  // Relay endpoint to fetch admin stats from the sidecar
  router.get('/admin/stats', async (req: any, res: any) => {
    try {
      const user = await peertubeHelpers.user.getAuthUser(res)
      const roleId = typeof user?.role === 'object' ? (user.role as any).id : user?.role
      if (!user || roleId !== 0) {
        return res.status(401).json({ error: 'Unauthorized: Admin only' })
      }

      const baseUrl = await getBaseUrl()
      if (!baseUrl) return res.status(500).json({ error: 'Base URL not configured' })

      const secret = await settingsManager.getSetting('webhook-secret') as string
      const response = await fetch(`${baseUrl}/api/connectors/peertube/admin/stats`, {
        headers: {
          'Authorization': `Bearer ${secret}`
        }
      })
      const data = await response.json()
      return res.status(response.status).json(data)
    } catch (err: any) {
      return res.status(500).json({ error: err.message })
    }
  })

  // Relay endpoint to fetch creator stats from the sidecar
  router.get('/creator/stats', async (req: any, res: any) => {
    try {
      const user = await peertubeHelpers.user.getAuthUser(res)
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized' })
      }

      const address = (req.query.address as string || '').trim()
      if (!address) {
        return res.status(400).json({ error: 'Missing address parameter' })
      }

      const baseUrl = await getBaseUrl()
      if (!baseUrl) return res.status(500).json({ error: 'Base URL not configured' })

      // Stats remain on the PeerTube connector; balance/withdraw live under /api/core/creator/*
      const response = await fetch(`${baseUrl}/api/connectors/peertube/creator/stats?address=${encodeURIComponent(address)}`)
      const data = await response.json()
      return res.status(response.status).json(data)
    } catch (err: any) {
      return res.status(500).json({ error: err.message })
    }
  })

  // Relay endpoint to fetch per-creator Gateway balance from the sidecar
  router.get('/creator/balance', async (req: any, res: any) => {
    try {
      const address = (req.query.address as string || '').trim()
      if (!address) {
        return res.status(400).json({ error: 'Missing address parameter' })
      }

      const baseUrl = await getBaseUrl()
      if (!baseUrl) return res.status(500).json({ error: 'Base URL not configured' })

      const response = await fetch(`${baseUrl}/api/core/creator/balance?address=${encodeURIComponent(address)}`)
      const data = await response.json()
      return res.status(response.status).json(data)
    } catch (err: any) {
      return res.status(500).json({ error: err.message })
    }
  })

  // Relay endpoint to prepare creator withdrawal intent from the sidecar
  router.post('/creator/prepare-withdraw', async (req: any, res: any) => {
    try {
      const baseUrl = await getBaseUrl()
      if (!baseUrl) return res.status(500).json({ error: 'Base URL not configured' })

      const response = await fetch(`${baseUrl}/api/core/creator/prepare-withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body)
      })
      const data = await response.json()
      return res.status(response.status).json(data)
    } catch (err: any) {
      return res.status(500).json({ error: err.message })
    }
  })

  // Relay endpoint to complete creator withdrawal attestation from the sidecar
  router.post('/creator/complete-withdraw', async (req: any, res: any) => {
    try {
      const baseUrl = await getBaseUrl()
      if (!baseUrl) return res.status(500).json({ error: 'Base URL not configured' })

      const response = await fetch(`${baseUrl}/api/core/creator/complete-withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body)
      })
      const data = await response.json()
      return res.status(response.status).json(data)
    } catch (err: any) {
      return res.status(500).json({ error: err.message })
    }
  })

  // Ping route handler
  router.post('/ping', async (req: any, res: any) => {
    // 5.3 Runtime type validation
    if (!req.body || typeof req.body !== 'object') {
       return res.status(400).json({ error: 'Invalid request body' })
    }
    const { action, videoId, videoUrl, sessionId } = req.body

    if (typeof videoId !== 'string' || !videoId) {
       return res.status(400).json({ error: 'Missing or invalid videoId' })
    }
    if (typeof videoUrl !== 'string') {
       return res.status(400).json({ error: 'Missing or invalid videoUrl' })
    }
    if (action !== 'start' && action !== 'stop' && action !== 'ping') {
       return res.status(400).json({ error: 'Invalid action' })
    }
    // sessionId is set by paywall.js in the browser's localStorage (arc_cashier_user_id)
    if (typeof sessionId !== 'string' || !sessionId || !sessionId.startsWith('arc_')) {
       return res.status(400).json({ error: 'Missing or invalid sessionId' })
    }

    // No PeerTube authentication required. Identity is provided by the paywall's sessionId.
    let channelId = ''
    let channelName = ''
    let views = 0
    let likes = 0
    let duration = 0
    let accountName = ''
    let tesseraMode = 'pay-per-second'
    let tesseraRate = ''
    let tesseraWallet = ''
    let isLocal = true
    let originInstanceUrl = peertubeHelpers.config.getWebserverUrl()
    let videoUuid = videoId
    let videoName = 'Unknown Video'

    try {
      const video = await loadVideoWithFallback(videoId) as any
      if (video) {
        if (video.uuid) videoUuid = video.uuid
        if (video.name) videoName = video.name
        if (video.VideoChannel) {
          channelId = video.VideoChannel.name || video.VideoChannel.id.toString()
          channelName = video.VideoChannel.displayName || channelId
        }
        views = video.views || 0
        likes = video.likes || 0
        duration = video.duration || 0
        if (video.Account) {
          accountName = video.Account.name || video.Account.displayName || ''
        }

        const resolved = await resolveTesseraMonetizationForVideo(
          storageManager,
          video,
          peertubeHelpers.config.getWebserverUrl()
        )
        isLocal = resolved.isLocal
        originInstanceUrl = resolved.originInstanceUrl
        if (resolved.data['tessera-mode']) tesseraMode = resolved.data['tessera-mode']
        if (resolved.data['tessera-rate']) tesseraRate = resolved.data['tessera-rate']
        if (resolved.data['tessera-wallet']) tesseraWallet = resolved.data['tessera-wallet']

        if (!isLocal) {
          peertubeHelpers.logger.info(
            `[tessera] Federated ping video=${videoUuid} origin=${originInstanceUrl} ` +
            `wallet=${tesseraWallet ? 'ok' : 'missing'} mode=${tesseraMode}`
          )
        }
      }
    } catch {
      peertubeHelpers.logger.warn(`[tessera] Could not load video metadata for ${videoId}`)
    }



    // 5.1: Rate limit check (1 req per 2s per session)
    if (action !== 'stop') {
        const lastPing = pingRateLimits.get(sessionId)
        if (lastPing && Date.now() - lastPing < 2000) {
           return res.status(429).json({ error: 'Too many requests' })
        }
        pingRateLimits.set(sessionId, Date.now())
    }

    const webhookSecret = (await settingsManager.getSetting('webhook-secret')) as string
    if (!webhookSecret) {
      peertubeHelpers.logger.error('[tessera] webhook-secret not configured. Refusing to process ping.')
      return res.status(503).json({ error: 'Plugin not configured' })
    }
    // Use the paywall's sessionId directly — must match what paywall.js sends to /register-session
    const userId = sessionId
    const instanceUrl = peertubeHelpers.config.getWebserverUrl()

    // Video metadata loading was moved above auth check

    const ratePerSecond = tesseraMode === 'free' ? 0 : Number(tesseraRate || '0.0001')
    const adminWallet = await settingsManager.getSetting('admin-wallet-address') as string
    const displayFeeStr = await settingsManager.getSetting('tessera-display-fee') as string || '0.10'
    const originFeeStr = await settingsManager.getSetting('tessera-origin-fee') as string || '0.10'

    const payloadData = {
      userId,
      videoId: videoUuid,
      videoName,
      videoUrl,
      channelId,
      channelName,
      accountName,
      views,
      likes,
      duration,
      tesseraMode,
      ratePerSecond,
      creatorAddress: tesseraWallet || undefined,
      creatorWallet: tesseraWallet || undefined,
      instanceUrl,
      adminWallet: adminWallet || undefined,
      displayFee: parseFloat(displayFeeStr),
      originFee: parseFloat(originFeeStr),
      originInstanceUrl,
      isLocal,
    }

    await enqueueAction(userId, async () => {
      if (action === 'start' || action === 'ping') {
        if (!activeViewers.has(userId)) {
          // SYNCHRONOUSLY add to activeViewers to prevent race conditions with 'stop'
          activeViewers.set(userId, {
            expireTime: Date.now() + TIMEOUT_MS,
            lastAccessTime: Date.now(),
            payload: payloadData
          })

          // Enforce Cache Limit via LRU
          const maxSize = await getMaxActiveViewers()
          if (activeViewers.size > maxSize) {
            const entries = [...activeViewers.entries()]
            entries.sort((a, b) => a[1].lastAccessTime - b[1].lastAccessTime)
            const lruKey = entries[0][0]
            
            if (lruKey) {
               const sessionToEvict = activeViewers.get(lruKey)
               activeViewers.delete(lruKey)
               if (sessionToEvict) {
                  sendWebhook('viewer_left', sessionToEvict.payload).catch(() => {})
               }
            }
          }

          const success = await sendWebhook('viewer_joined', payloadData)
          if (!success) {
             activeViewers.delete(userId)
             res.status(502).json({ error: 'Failed to notify payment sidecar' })
             return
          }
        } else {
          // Update expiration time
          const session = activeViewers.get(userId)
          if (session) {
            session.expireTime = Date.now() + TIMEOUT_MS
            session.lastAccessTime = Date.now()
            session.payload = payloadData
          }
        }

      } else if (action === 'stop') {
        const session = activeViewers.get(userId)
        if (session) {
          session.pendingAction = 'stop'
          // Send webhook BEFORE deleting to avoid ghost sessions
          const success = await sendWebhook('viewer_left', payloadData)
          const currentSession = activeViewers.get(userId)
          if (currentSession) {
             currentSession.pendingAction = null
             if (success) {
                activeViewers.delete(userId)
             } else {
                res.status(502).json({ error: 'Failed to stop session webhook' })
                return
             }
          }
        }
      }
    })

    if (!res.headersSent) {
      // If the video is free, tell the client to stop pinging and show the tip button
      if (tesseraMode === 'free') {
        const tesseraTipAmount = (await loadTesseraVideoData(storageManager, videoId as any, undefined))['tessera-tip-amount'] || '0.10'
        res.json({ success: true, tesseraMode, free: true, tipAmount: tesseraTipAmount, creatorWallet: tesseraWallet || null })
      } else {
        res.json({ success: true, tesseraMode, ratePerSecond })
      }
    }
  })
}

export async function unregister () {
  // Cleanup logic if needed
}
