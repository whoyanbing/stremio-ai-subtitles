// llm-subtitle-addon — 使用大模型自动翻译字幕的 Stremio 插件
// 支持 OpenAI 兼容接口（DeepSeek / Moonshot / Ollama 等）

const { addonBuilder, getRouter } = require('stremio-addon-sdk')
const express = require('express')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const PORT = process.env.PORT || 7000
// Railway 会自动设置 RAILWAY_PUBLIC_DOMAIN，否则用环境变量或 fallback
const PUBLIC_URL = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://127.0.0.1:${PORT}`)

const CACHE_DIR = path.join(__dirname, 'cache')
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })

function cacheKey(videoId, lang) {
  return crypto.createHash('md5').update(`${videoId}-${lang}`).digest('hex')
}

// ---------- 字幕源 ----------
// 通过 videoHash + videoSize 精准匹配字幕文件
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

  // 下载字幕文件
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

// 按 IMDb ID 从 OpenSubtitles 搜索（fallback）
async function fetchSubsByImdbId(imdbId, lang, apiKey) {
  if (!imdbId || !apiKey) return null

  const res = await fetch(
    `https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${imdbId.replace('tt', '')}&languages=${lang}`,
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

// ---------- LLM 翻译 ----------
async function translateSrt(sourceSrt, targetLang, apiKey, apiBase, model) {
  const prompt = `你是一个专业字幕翻译专家。将以下SRT格式的字幕翻译成${targetLang}。
严格保持SRT格式不变（时间轴、序号），只翻译文本内容。
确保翻译自然流畅，符合${targetLang}表达习惯。
完整返回全部字幕内容：

${sourceSrt}`

  const base = (apiBase || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 16384,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`LLM API ${res.status}: ${text}`)
  }
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error(`LLM 返回异常: ${JSON.stringify(data)}`)
  return content
}

// ---------- Manifest ----------
const manifest = {
  id: 'org.example.llm-subtitles',
  version: '1.0.0',
  name: 'AI 字幕翻译',
  description: '使用 DeepSeek / OpenAI 等大模型自动翻译字幕',
  catalogs: [],
  resources: ['subtitles'],
  types: ['movie', 'series'],
  behaviorHints: { configurable: true },
  config: [
    { key: 'llmApiKey', type: 'text', title: 'LLM API Key', required: true },
    { key: 'llmApiBase', type: 'text', title: 'LLM API 地址', default: 'https://api.deepseek.com' },
    { key: 'llmModel', type: 'text', title: '模型名称', default: 'deepseek-chat' },
    { key: 'targetLang', type: 'text', title: '目标语言', default: '简体中文' },
    { key: 'subsApiKey', type: 'text', title: 'OpenSubtitles API Key（可选，用于获取原始字幕）' },
  ],
}

const builder = new addonBuilder(manifest)

// ---------- Subtitle Handler ----------
builder.defineSubtitlesHandler(async ({ type, id, extra, config }) => {
  const targetLang = config?.targetLang || '简体中文'
  const llmApiKey = config?.llmApiKey
  const llmApiBase = config?.llmApiBase || 'https://api.deepseek.com'
  const llmModel = config?.llmModel || 'deepseek-chat'
  const subsApiKey = config?.subsApiKey

  if (!llmApiKey) return { subtitles: [], cacheMaxAge: 3600 }

  const key = cacheKey(id, targetLang)
  const cacheFile = path.join(CACHE_DIR, `${key}.srt`)

  // 命中缓存直接返回
  if (fs.existsSync(cacheFile)) {
    return {
      subtitles: [{
        id: `${key}-${targetLang}`,
        url: `${PUBLIC_URL}/srt/${key}.vtt`,
        lang: targetLang,
      }],
      cacheMaxAge: 86400 * 30,
    }
  }

  try {
    // Step 1: 获取原始英文字幕
    let sourceSrt = null
    const imdbId = id.startsWith('tt') ? id : null

    if (subsApiKey) {
      // 优先用 hash 精准匹配
      sourceSrt = await fetchSubsFromOpenSubtitles(extra?.videoHash, extra?.videoSize, subsApiKey)
      // fallback 到 IMDb ID 搜索英文字幕
      if (!sourceSrt && imdbId) {
        sourceSrt = await fetchSubsByImdbId(imdbId, 'en', subsApiKey)
      }
    }

    if (!sourceSrt) {
      // 无字幕源时返回空，避免反复请求
      return { subtitles: [], cacheMaxAge: 3600 }
    }

    // Step 2: LLM 翻译
    const translated = await translateSrt(sourceSrt, targetLang, llmApiKey, llmApiBase, llmModel)
    fs.writeFileSync(cacheFile, translated, 'utf-8')

    return {
      subtitles: [{
        id: `${key}-${targetLang}`,
        url: `${PUBLIC_URL}/srt/${key}.vtt`,
        lang: targetLang,
      }],
      cacheMaxAge: 86400 * 30,
    }
  } catch (err) {
    console.error('翻译失败:', err)
    return { subtitles: [], cacheMaxAge: 3600 }
  }
})

// ---------- Express 服务器 ----------
const app = express()

// 提供翻译后的字幕文件（SRT → VTT）
app.get('/srt/:key.vtt', (req, res) => {
  const file = path.join(CACHE_DIR, `${req.params.key}.srt`)
  if (!fs.existsSync(file)) return res.status(404).end()

  const srt = fs.readFileSync(file, 'utf-8')
  const vtt = 'WEBVTT\n\n' + srt.replace(/,/g, '.')
  res.set('Content-Type', 'text/vtt; charset=utf-8')
  res.set('Access-Control-Allow-Origin', '*')
  res.send(vtt)
})

// 健康检查
app.get('/health', (_, res) => res.json({ ok: true, cacheSize: fs.readdirSync(CACHE_DIR).length }))

// 挂载 Stremio addon 路由
app.use('/', getRouter(builder.getInterface()))

app.listen(PORT, () => {
  console.log(`AI 字幕插件运行中`)
  console.log(`  本地地址: http://127.0.0.1:${PORT}/manifest.json`)
  console.log(`  公网地址: ${PUBLIC_URL}/manifest.json`)
})
