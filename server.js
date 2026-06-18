const { addonBuilder, getRouter } = require('stremio-addon-sdk')
const express = require('express')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const PORT = process.env.PORT || 7000
const PUBLIC_URL = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://127.0.0.1:${PORT}`)

const CONFIG = {
  llmApiKey: 'sk-OdCLwCMk87oNeMpgbJpnjgdEMpBcoi7Z',
  llmApiBase: 'https://token.sensenova.cn/v1',
  llmModel: 'deepseek-v4-flash',
  lang: 'chi',
  targetLangName: 'Chinese',
  subsApiKey: 'StsEHnr7VCueKUGTaoLwRO0ActwtvQMu',
}

const HTTP_TIMEOUT = 15000

const CACHE_DIR = path.join(__dirname, 'cache')
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })

const requestLog = []

function logRequest(type, id, extra, result) {
  const entry = { t: Date.now(), type, id, extra: extra ? { vh: !!extra.videoHash, vs: !!extra.videoSize, fn: extra.filename } : null, r: result }
  requestLog.push(entry)
  if (requestLog.length > 50) requestLog.shift()
}

function cacheKey(videoId, lang) {
  return crypto.createHash('md5').update(`${videoId}-${lang}`).digest('hex')
}

function extractImdbId(id) {
  if (!id || !id.startsWith('tt')) return null
  const match = id.match(/^tt(\d+)/)
  return match ? match[0] : null
}

async function fetchWithTimeout(url, opts = {}, timeout = HTTP_TIMEOUT) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchSubsFromOpenSubtitles(hash, size, apiKey) {
  if (!hash || !size || !apiKey) return null
  const res = await fetchWithTimeout(
    `https://api.opensubtitles.com/api/v1/subtitles?moviehash=${hash}&moviebytesize=${size}`,
    { headers: { 'Api-Key': apiKey, 'User-Agent': 'LLMSubtitleAddon v1.0' } }
  )
  if (!res.ok) return null
  const data = await res.json()
  const sub = data?.data?.[0]?.attributes
  if (!sub?.files?.[0]?.file_id) return null
  const dl = await fetchWithTimeout('https://api.opensubtitles.com/api/v1/download', {
    method: 'POST',
    headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json', 'User-Agent': 'LLMSubtitleAddon v1.0' },
    body: JSON.stringify({ file_id: sub.files[0].file_id }),
  })
  if (!dl.ok) return null
  const dlData = await dl.json()
  if (!dlData.link) return null
  const srtRes = await fetchWithTimeout(dlData.link)
  return srtRes.ok ? await srtRes.text() : null
}

async function fetchSubsByImdbId(imdbId, apiKey) {
  if (!imdbId || !apiKey) return null
  const num = imdbId.replace('tt', '')
  const res = await fetchWithTimeout(
    `https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${num}&order_by=download_count&sublanguage_id=all`,
    { headers: { 'Api-Key': apiKey, 'User-Agent': 'LLMSubtitleAddon v1.0' } }
  )
  if (!res.ok) { console.log(`[os] search fail: ${res.status}`); return null }
  const data = await res.json()
  const sub = data?.data?.[0]?.attributes
  if (!sub?.files?.[0]?.file_id) { console.log(`[os] no result: ${data?.data?.length}`); return null }
  console.log(`[os] hit: lang=${sub.language} fid=${sub.files[0].file_id}`)
  const dl = await fetchWithTimeout('https://api.opensubtitles.com/api/v1/download', {
    method: 'POST',
    headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json', 'User-Agent': 'LLMSubtitleAddon v1.0' },
    body: JSON.stringify({ file_id: sub.files[0].file_id }),
  })
  if (!dl.ok) { console.log(`[os] dl fail: ${dl.status}`); return null }
  const dlData = await dl.json()
  if (!dlData.link) return null
  const srtRes = await fetchWithTimeout(dlData.link)
  return srtRes.ok ? await srtRes.text() : null
}

async function translateSrt(sourceSrt, targetLang, apiKey, apiBase, model) {
  const prompt = `Translate the following SRT subtitle to ${targetLang}.
Keep the SRT format exactly (timestamps, sequence numbers). Only translate the text.
Return ALL subtitles:

${sourceSrt}`
  const base = (apiBase || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const res = await fetchWithTimeout(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 16384,
    }),
  }, 60000)
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error(`LLM bad response: ${JSON.stringify(data)}`)
  return content
}

const manifest = {
  id: 'org.example.llm-subtitles',
  version: '1.0.0',
  name: 'AI 字幕翻译',
  description: 'AI-powered subtitle translation',
  catalogs: [],
  resources: ['subtitles'],
  types: ['movie', 'series'],
}

const builder = new addonBuilder(manifest)

builder.defineSubtitlesHandler(async ({ type, id, extra }) => {
  const { lang, targetLangName, llmApiKey, llmApiBase, llmModel, subsApiKey } = CONFIG
  if (!llmApiKey) { logRequest(type, id, extra, 'no_key'); return { subtitles: [], cacheMaxAge: 3600 } }

  const key = cacheKey(id, lang)
  const cacheFile = path.join(CACHE_DIR, `${key}.srt`)
  if (fs.existsSync(cacheFile)) {
    logRequest(type, id, extra, 'cache_hit')
    return { subtitles: [{ id: `${key}-${lang}`, url: `${PUBLIC_URL}/srt/${key}.vtt`, lang }], cacheMaxAge: 86400 * 30 }
  }

  try {
    let sourceSrt = null
    const imdbId = extractImdbId(id)
    console.log(`[sub] req: type=${type} id=${id} imdb=${imdbId} hash=${!!extra?.videoHash} size=${!!extra?.videoSize}`)

    if (subsApiKey) {
      if (extra?.videoHash && extra?.videoSize) {
        sourceSrt = await fetchSubsFromOpenSubtitles(extra.videoHash, extra.videoSize, subsApiKey)
      }
      if (!sourceSrt && imdbId) {
        sourceSrt = await fetchSubsByImdbId(imdbId, subsApiKey)
      }
    }

    if (!sourceSrt) {
      console.log(`[sub] no source for ${id}`)
      logRequest(type, id, extra, 'no_source')
      return { subtitles: [], cacheMaxAge: 7200 }
    }

    console.log(`[sub] translating ${sourceSrt.length} chars...`)
    const translated = await translateSrt(sourceSrt, targetLangName, llmApiKey, llmApiBase, llmModel)
    if (!translated) { logRequest(type, id, extra, 'trans_fail'); return { subtitles: [], cacheMaxAge: 3600 } }
    fs.writeFileSync(cacheFile, translated, 'utf-8')
    logRequest(type, id, extra, 'ok')
    return { subtitles: [{ id: `${key}-${lang}`, url: `${PUBLIC_URL}/srt/${key}.vtt`, lang }], cacheMaxAge: 86400 * 30 }
  } catch (err) {
    console.error('[sub] error:', err)
    logRequest(type, id, extra, 'error')
    return { subtitles: [], cacheMaxAge: 3600 }
  }
})

const app = express()

app.get('/srt/:key.vtt', (req, res) => {
  const file = path.join(CACHE_DIR, `${req.params.key}.srt`)
  if (!fs.existsSync(file)) return res.status(404).end()
  res.set('Content-Type', 'text/vtt; charset=utf-8')
  res.set('Access-Control-Allow-Origin', '*')
  res.send('WEBVTT\n\n' + fs.readFileSync(file, 'utf-8').replace(/,/g, '.'))
})

app.get('/health', (_, res) => res.json({ ok: true, cacheSize: fs.readdirSync(CACHE_DIR).length }))

app.get('/debug', (_, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`<!DOCTYPE html>
<html><body style="font-family:sans-serif;padding:20px">
<h2>Debug</h2>
<p><a href="/debug/requests" target="_blank">查看最近请求日志</a></p>
<form action="/debug/search" method="get" target="_blank">
  <p>IMDb: <input name="id" placeholder="tt1375666" size="30">
  <button>Search subs</button></p>
</form>
<form action="/debug/translate" method="get" target="_blank">
  <p>IMDb: <input name="id" placeholder="tt1375666" size="30">
  <button>Search + Translate</button></p>
</form>
</body></html>`)
})

app.get('/debug/requests', (_, res) => {
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  if (requestLog.length === 0) return res.end('no requests yet\n')
  res.end(requestLog.map(e =>
    `[${new Date(e.t).toISOString()}] type=${e.type} id=${e.id} result=${e.r} extra=${JSON.stringify(e.extra)}`
  ).join('\n') + '\n')
})

app.get('/debug/search', async (req, res) => {
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  const id = req.query.id
  if (!id || !CONFIG.subsApiKey) return res.end('missing id or key\n')
  try {
    const srt = await fetchSubsByImdbId(id, CONFIG.subsApiKey)
    if (srt) res.end(`found ${srt.length} chars\n${srt.slice(0, 300)}\n`)
    else res.end('not found\n')
  } catch (e) { res.end(`error: ${e.message}\n`) }
})

app.get('/debug/translate', async (req, res) => {
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  const id = req.query.id
  if (!id) return res.end('missing id\n')
  try {
    const srt = await fetchSubsByImdbId(id, CONFIG.subsApiKey)
    if (!srt) return res.end('no subs found\n')
    const t = await translateSrt(srt.slice(0, 500), CONFIG.targetLangName, CONFIG.llmApiKey, CONFIG.llmApiBase, CONFIG.llmModel)
    res.end(`ok\n${t}\n`)
  } catch (e) { res.end(`error: ${e.message}\n`) }
})

app.use('/', getRouter(builder.getInterface()))

app.listen(PORT, () => console.log(`running: ${PUBLIC_URL}/manifest.json`))
