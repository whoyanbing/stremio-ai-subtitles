const { addonBuilder, getRouter } = require('stremio-addon-sdk')
const express = require('express')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const PORT = process.env.PORT || 7000
const PUBLIC_URL = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://127.0.0.1:${PORT}`)

// ===== 在这里配置你的 API Key =====
const CONFIG = {
  llmApiKey: 'your-deepseek-api-key-here',
  llmApiBase: 'https://api.deepseek.com',
  llmModel: 'deepseek-chat',
  targetLang: '简体中文',
  subsApiKey: 'your-opensubtitles-api-key-here',
}
// =================================

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

async function fetchSubsFromOpenSubtitles(hash, size, apiKey) {
  if (!hash || !size || !apiKey) return null
  const res = await fetch(
    `https://api.opensubtitles.com/api/v1/subtitles?moviehash=${hash}&moviebytesize=${size}`,
    { headers: { 'Api-Key': apiKey, 'User-Agent': 'LLMSubtitleAddon v1.0' } }
  )
  if (!res.ok) return null
  const data = await res.json()
  const sub = data?.data?.[0]?.attributes
  if (!sub?.files?.[0]?.file_id) return null
  const dl = await fetch('https://api.opensubtitles.com/api/v1/download', {
    method: 'POST',
    headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json', 'User-Agent': 'LLMSubtitleAddon v1.0' },
    body: JSON.stringify({ file_id: sub.files[0].file_id }),
  })
  if (!dl.ok) return null
  const dlData = await dl.json()
  if (!dlData.link) return null
  const srtRes = await fetch(dlData.link)
  return srtRes.ok ? await srtRes.text() : null
}

async function fetchSubsByImdbId(imdbId, apiKey) {
  if (!imdbId || !apiKey) return null
  const num = imdbId.replace('tt', '')
  const res = await fetch(
    `https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${num}&order_by=download_count&sublanguage_id=all`,
    { headers: { 'Api-Key': apiKey, 'User-Agent': 'LLMSubtitleAddon v1.0' } }
  )
  if (!res.ok) { console.log(`[llm-subtitle] OpenSubtitles search 失败: ${res.status}`); return null }
  const data = await res.json()
  const sub = data?.data?.[0]?.attributes
  if (!sub?.files?.[0]?.file_id) { console.log(`[llm-subtitle] 未找到字幕: ${data?.data?.length} 条结果`); return null }
  console.log(`[llm-subtitle] 找到字幕: language=${sub.language} 文件ID=${sub.files[0].file_id}`)
  const dl = await fetch('https://api.opensubtitles.com/api/v1/download', {
    method: 'POST',
    headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json', 'User-Agent': 'LLMSubtitleAddon v1.0' },
    body: JSON.stringify({ file_id: sub.files[0].file_id }),
  })
  if (!dl.ok) { console.log(`[llm-subtitle] 字幕下载失败: ${dl.status}`); return null }
  const dlData = await dl.json()
  if (!dlData.link) return null
  const srtRes = await fetch(dlData.link)
  return srtRes.ok ? await srtRes.text() : null
}

async function translateSrt(sourceSrt, targetLang, apiKey, apiBase, model) {
  const prompt = `你是一个专业字幕翻译专家。将以下SRT格式的字幕翻译成${targetLang}。
严格保持SRT格式不变（时间轴、序号），只翻译文本内容。
确保翻译自然流畅，符合${targetLang}表达习惯。
完整返回全部字幕内容：

${sourceSrt}`
  const base = (apiBase || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 16384,
    }),
  })
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
}

const builder = new addonBuilder(manifest)

builder.defineSubtitlesHandler(async ({ type, id, extra }) => {
  const { targetLang, llmApiKey, llmApiBase, llmModel, subsApiKey } = CONFIG
  if (!llmApiKey) { console.log('[llm-subtitle] 无 LLM API Key'); return { subtitles: [], cacheMaxAge: 3600 } }

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

    if (!sourceSrt) { console.log(`[llm-subtitle] 未找到源字幕`); return { subtitles: [], cacheMaxAge: 7200 } }

    const translated = await translateSrt(sourceSrt, targetLang, llmApiKey, llmApiBase, llmModel)
    if (!translated) return { subtitles: [], cacheMaxAge: 3600 }
    fs.writeFileSync(cacheFile, translated, 'utf-8')
    console.log(`[llm-subtitle] 翻译完成: ${key}`)
    return { subtitles: [{ id: `${key}-${targetLang}`, url: `${PUBLIC_URL}/srt/${key}.vtt`, lang: targetLang }], cacheMaxAge: 86400 * 30 }
  } catch (err) {
    console.error('[llm-subtitle] 错误:', err)
    return { subtitles: [], cacheMaxAge: 3600 }
  }
})

const app = express()

app.get('/srt/:key.vtt', (req, res) => {
  const file = path.join(CACHE_DIR, `${req.params.key}.srt`)
  if (!fs.existsSync(file)) return res.status(404).end()
  const srt = fs.readFileSync(file, 'utf-8')
  res.set('Content-Type', 'text/vtt; charset=utf-8')
  res.set('Access-Control-Allow-Origin', '*')
  res.send('WEBVTT\n\n' + srt.replace(/,/g, '.'))
})

app.get('/health', (_, res) => res.json({ ok: true, cacheSize: fs.readdirSync(CACHE_DIR).length }))

app.get('/debug', (_, res) => {
  res.setHeader('content-type', 'text/html')
  res.end(`<!DOCTYPE html>
<html><body style="font-family:sans-serif;padding:20px">
<h2>AI 字幕翻译 - 调试</h2>
<form action="/debug/test" method="get">
  <p>IMDb ID: <input name="id" placeholder="tt1375666" size="30">
  <button type="submit">测试</button></p>
</form>
<ul>
  <li>LLM: ${CONFIG.llmApiKey ? CONFIG.llmApiKey.slice(0, 8) + '...' : '未配置'}
  <li>OpenSubtitles: ${CONFIG.subsApiKey ? CONFIG.subsApiKey.slice(0, 8) + '...' : '未配置'}
  <li>API Base: ${CONFIG.llmApiBase}
  <li>Model: ${CONFIG.llmModel}
  <li>Target: ${CONFIG.targetLang}
</ul>
</body></html>`)
})

app.get('/debug/test', async (req, res) => {
  res.setHeader('content-type', 'text/plain')
  const imdbId = req.query.id
  if (!imdbId) return res.end('请输入 IMDb ID')
  res.write(`测试 IMDb ID: ${imdbId}\n\n`)
  if (CONFIG.subsApiKey) {
    res.write(`[1/3] 搜索 OpenSubtitles...\n`)
    const srt = await fetchSubsByImdbId(imdbId, CONFIG.subsApiKey)
    if (srt) {
      res.write(`  找到字幕! ${srt.length} 字符\n  前200: ${srt.slice(0, 200)}\n\n`)
      if (CONFIG.llmApiKey) {
        res.write(`[2/3] LLM 翻译中...\n`)
        try {
          const translated = await translateSrt(srt, CONFIG.targetLang, CONFIG.llmApiKey, CONFIG.llmApiBase, CONFIG.llmModel)
          if (translated) res.write(`[3/3] ✅ 翻译完成! ${translated.length} 字符\n${translated.slice(0, 200)}\n`)
        } catch (e) { res.write(`  ❌ 翻译失败: ${e.message}\n`) }
      }
    } else { res.write(`  ❌ 未找到字幕\n`) }
  } else { res.write(`未配置 OpenSubtitles Key\n`) }
  res.end()
})

app.use('/', getRouter(builder.getInterface()))

app.listen(PORT, () => {
  console.log(`AI 字幕插件运行中: ${PUBLIC_URL}/manifest.json`)
})
