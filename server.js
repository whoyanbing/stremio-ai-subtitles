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
  targetLang: '简体中文',
  subsApiKey: 'StsEHnr7VCueKUGTaoLwRO0ActwtvQMu',
}

const HTTP_TIMEOUT = 15000

const CACHE_DIR = path.join(__dirname, 'cache')
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })

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
    const res = await fetch(url, { ...opts, signal: ctrl.signal })
    return res
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
  if (!res.ok) { console.log(`[llm-subtitle] OS search 失败: ${res.status}`); return null }
  const data = await res.json()
  const sub = data?.data?.[0]?.attributes
  if (!sub?.files?.[0]?.file_id) { console.log(`[llm-subtitle] OS 无结果: ${data?.data?.length}`); return null }
  console.log(`[llm-subtitle] OS 命中: lang=${sub.language} fid=${sub.files[0].file_id}`)
  const dl = await fetchWithTimeout('https://api.opensubtitles.com/api/v1/download', {
    method: 'POST',
    headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json', 'User-Agent': 'LLMSubtitleAddon v1.0' },
    body: JSON.stringify({ file_id: sub.files[0].file_id }),
  })
  if (!dl.ok) { console.log(`[llm-subtitle] OS dl 失败: ${dl.status}`); return null }
  const dlData = await dl.json()
  if (!dlData.link) return null
  const srtRes = await fetchWithTimeout(dlData.link)
  return srtRes.ok ? await srtRes.text() : null
}

async function translateSrt(sourceSrt, targetLang, apiKey, apiBase, model) {
  const prompt = `你是一个专业字幕翻译专家。将以下SRT格式的字幕翻译成${targetLang}。
严格保持SRT格式不变（时间轴、序号），只翻译文本内容。
确保翻译自然流畅，符合${targetLang}表达习惯。
完整返回全部字幕内容：

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
  if (!res.ok) throw new Error(`LLM API ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error(`LLM 返回异常: ${JSON.stringify(data)}`)
  return content
}

const manifest = {
  id: 'org.example.llm-subtitles',
  version: '1.0.0',
  name: 'AI 字幕翻译',
  description: '使用大模型自动翻译字幕',
  catalogs: [],
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
}

const builder = new addonBuilder(manifest)

builder.defineSubtitlesHandler(async ({ type, id, extra }) => {
  const { targetLang, llmApiKey, llmApiBase, llmModel, subsApiKey } = CONFIG

  // 先返回一条测试字幕，确认 Stremio 是否调用了我们
  const testKey = cacheKey('test', targetLang)
  const testFile = path.join(CACHE_DIR, `${testKey}.srt`)
  if (!fs.existsSync(testFile)) {
    fs.writeFileSync(testFile, `1\n00:00:01,000 --> 00:00:05,000\n测试字幕 - 插件正常运行\n2\n00:00:06,000 --> 00:00:10,000\nTest subtitle - addon is working`, 'utf-8')
  }

  if (!llmApiKey) { console.log('[llm-subtitle] 无 LLM Key'); return { subtitles: [{ id: testKey, url: `${PUBLIC_URL}/srt/${testKey}.vtt`, lang: targetLang }], cacheMaxAge: 3600 } }

  const key = cacheKey(id, targetLang)
  const cacheFile = path.join(CACHE_DIR, `${key}.srt`)
  if (fs.existsSync(cacheFile)) {
    return { subtitles: [{ id: `${key}-${targetLang}`, url: `${PUBLIC_URL}/srt/${key}.vtt`, lang: targetLang }], cacheMaxAge: 86400 * 30 }
  }

  try {
    let sourceSrt = null
    const imdbId = extractImdbId(id)
    console.log(`[llm-subtitle] 请求: type=${type} id=${id} imdbId=${imdbId}`)

    if (subsApiKey) {
      if (extra?.videoHash && extra?.videoSize) {
        sourceSrt = await fetchSubsFromOpenSubtitles(extra.videoHash, extra.videoSize, subsApiKey)
      }
      if (!sourceSrt && imdbId) {
        sourceSrt = await fetchSubsByImdbId(imdbId, subsApiKey)
      }
    }

    if (!sourceSrt) {
      console.log(`[llm-subtitle] 无源字幕，返回测试字幕`)
      return { subtitles: [{ id: testKey, url: `${PUBLIC_URL}/srt/${testKey}.vtt`, lang: targetLang }], cacheMaxAge: 7200 }
    }

    const translated = await translateSrt(sourceSrt, targetLang, llmApiKey, llmApiBase, llmModel)
    if (!translated) return { subtitles: [], cacheMaxAge: 3600 }
    fs.writeFileSync(cacheFile, translated, 'utf-8')
    console.log(`[llm-subtitle] 完成: ${key}`)
    return { subtitles: [{ id: `${key}-${targetLang}`, url: `${PUBLIC_URL}/srt/${key}.vtt`, lang: targetLang }], cacheMaxAge: 86400 * 30 }
  } catch (err) {
    console.error('[llm-subtitle] 错误:', err)
    return { subtitles: [{ id: testKey, url: `${PUBLIC_URL}/srt/${testKey}.vtt`, lang: targetLang }], cacheMaxAge: 3600 }
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
<h2>AI 字幕翻译 - 调试</h2>
<form action="/debug/test" method="get" target="_blank">
  <p>IMDb ID: <input name="id" placeholder="tt1375666" size="30">
  <button type="submit">测试</button></p>
</form>
<p>先测试 OpenSubtitles 搜索（不调用 LLM）：</p>
<form action="/debug/search" method="get" target="_blank">
  <p>IMDb ID: <input name="id" placeholder="tt1375666" size="30">
  <button type="submit">仅搜索字幕</button></p>
</form>
<ul>
  <li>LLM: ${CONFIG.llmApiKey ? CONFIG.llmApiKey.slice(0, 8) + '...' : '无'}
  <li>OpenSubtitles: ${CONFIG.subsApiKey ? CONFIG.subsApiKey.slice(0, 8) + '...' : '无'}
  <li>API Base: ${CONFIG.llmApiBase}
  <li>Model: ${CONFIG.llmModel}
</ul>
</body></html>`)
})

app.get('/debug/search', async (req, res) => {
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  const imdbId = req.query.id
  if (!imdbId) return res.end('missing id')
  res.write(`搜索字幕: ${imdbId}\n`)
  if (!CONFIG.subsApiKey) return res.end('无 OpenSubtitles Key\n')
  try {
    const srt = await fetchSubsByImdbId(imdbId, CONFIG.subsApiKey)
    if (srt) res.end(`找到! ${srt.length} 字符\n---前300---\n${srt.slice(0, 300)}\n`)
    else res.end('未找到字幕\n')
  } catch (e) {
    res.end(`错误: ${e.message}\n`)
  }
})

app.get('/debug/test', async (req, res) => {
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.setHeader('Transfer-Encoding', 'chunked')
  const imdbId = req.query.id
  if (!imdbId) return res.end('missing id\n')

  res.write(`测试: ${imdbId}\n\n`)

  if (!CONFIG.subsApiKey) { res.write('无 OpenSubtitles Key\n'); return res.end() }
  if (!CONFIG.llmApiKey) { res.write('无 LLM Key\n'); return res.end() }

  res.write('[1] 搜索 OpenSubtitles...\n')
  try {
    const start = Date.now()
    const srt = await fetchSubsByImdbId(imdbId, CONFIG.subsApiKey)
    res.write(`  耗时: ${Date.now() - start}ms\n`)
    if (!srt) { res.write('  未找到字幕\n'); return res.end() }
    res.write(`  找到! ${srt.length} 字符\n\n`)
  } catch (e) { res.write(`  ❌ ${e.message}\n`); return res.end() }

  res.write('[2] LLM 翻译...\n')
  try {
    const start = Date.now()
    const translated = await translateSrt(
      '1\n00:00:01,000 --> 00:00:05,000\nHello world, this is a test subtitle.\n\n2\n00:00:06,000 --> 00:00:10,000\nThis is the second line of the test.',
      CONFIG.targetLang, CONFIG.llmApiKey, CONFIG.llmApiBase, CONFIG.llmModel
    )
    res.write(`  耗时: ${Date.now() - start}ms\n`)
    if (translated) res.write(`  ✅ 翻译成功!\n${translated}\n`)
    else res.write('  ❌ 翻译返回空\n')
  } catch (e) { res.write(`  ❌ ${e.message}\n`) }

  res.end()
})

app.use('/', getRouter(builder.getInterface()))

app.listen(PORT, () => {
  console.log(`AI 字幕插件运行中: ${PUBLIC_URL}/manifest.json`)
})
