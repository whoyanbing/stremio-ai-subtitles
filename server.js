// llm-subtitle-addon — 使用大模型自动翻译字幕的 Stremio 插件
// 支持 OpenAI 兼容接口（DeepSeek / Moonshot / Ollama 等）

const { addonBuilder, getRouter } = require('stremio-addon-sdk')
const landingTemplate = require('stremio-addon-sdk/src/landingTemplate')
const express = require('express')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const PORT = process.env.PORT || 7000
const PUBLIC_URL = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://127.0.0.1:${PORT}`)

// 环境变量兜底：可在 Railway Dashboard → Variables 中设置
const ENV_LLM_KEY = process.env.LLM_API_KEY
const ENV_LLM_BASE = process.env.LLM_API_BASE || 'https://api.deepseek.com'
const ENV_LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat'
const ENV_TARGET_LANG = process.env.TARGET_LANG || '简体中文'
const ENV_SUBS_KEY = process.env.OPENSUBTITLES_API_KEY

const CACHE_DIR = path.join(__dirname, 'cache')
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })

function cacheKey(videoId, lang) {
  return crypto.createHash('md5').update(`${videoId}-${lang}`).digest('hex')
}

// 从 id 中提取纯 IMDb ID（处理 "tt1234567:1:2" 剧集格式）
function extractImdbId(id) {
  if (!id || !id.startsWith('tt')) return null
  const match = id.match(/^tt(\d+)/)
  return match ? match[0] : null
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

// 按 IMDb ID 搜索字幕（不限语言，LLM 可以翻译任何语言）
async function fetchSubsByImdbId(imdbId, apiKey) {
  if (!imdbId || !apiKey) return null

  const num = imdbId.replace('tt', '')
  // 搜索所有语言的字幕，按下载量排序取第一个
  const res = await fetch(
    `https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${num}&order_by=download_count&sublanguage_id=all`,
    { headers: { 'Api-Key': apiKey, 'User-Agent': 'LLMSubtitleAddon v1.0' } }
  )
  if (!res.ok) {
    console.log(`[llm-subtitle] OpenSubtitles search 失败: ${res.status}`)
    return null
  }
  const data = await res.json()
  const sub = data?.data?.[0]?.attributes
  if (!sub?.files?.[0]?.file_id) {
    console.log(`[llm-subtitle] 未找到字幕: ${JSON.stringify(data?.data?.length)} 条结果`)
    return null
  }

  console.log(`[llm-subtitle] 找到字幕: language=${sub.language} 文件ID=${sub.files[0].file_id}`)

  const dl = await fetch('https://api.opensubtitles.com/api/v1/download', {
    method: 'POST',
    headers: { 'Api-Key': apiKey, 'Content-Type': 'application/json', 'User-Agent': 'LLMSubtitleAddon v1.0' },
    body: JSON.stringify({ file_id: sub.files[0].file_id }),
  })
  if (!dl.ok) {
    console.log(`[llm-subtitle] 字幕下载失败: ${dl.status}`)
    return null
  }
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
  // 优先用 Stremio UI 传入的 config，其次用环境变量
  const targetLang = config?.targetLang || ENV_TARGET_LANG
  const llmApiKey = config?.llmApiKey || ENV_LLM_KEY
  const llmApiBase = config?.llmApiBase || ENV_LLM_BASE
  const llmModel = config?.llmModel || ENV_LLM_MODEL
  const subsApiKey = config?.subsApiKey || ENV_SUBS_KEY

  if (!llmApiKey) {
    console.log('[llm-subtitle] 无 LLM API Key，跳过')
    return { subtitles: [], cacheMaxAge: 3600 }
  }

  const key = cacheKey(id, targetLang)
  const cacheFile = path.join(CACHE_DIR, `${key}.srt`)

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
    let sourceSrt = null
    const imdbId = extractImdbId(id)
    console.log(`[llm-subtitle] 请求: type=${type} id=${id} imdbId=${imdbId} hasSubsKey=${!!subsApiKey}`)

    if (subsApiKey) {
      // 1) 优先用 videoHash 精准匹配
      if (extra?.videoHash && extra?.videoSize) {
        sourceSrt = await fetchSubsFromOpenSubtitles(extra.videoHash, extra.videoSize, subsApiKey)
        console.log(`[llm-subtitle] hash查询: ${!!sourceSrt}`)
      }
      // 2) 按 IMDb ID 搜索任意语言字幕
      if (!sourceSrt && imdbId) {
        sourceSrt = await fetchSubsByImdbId(imdbId, subsApiKey)
        console.log(`[llm-subtitle] imdb查询: ${!!sourceSrt}`)
      }
    }

    if (!sourceSrt) {
      console.log(`[llm-subtitle] 未找到源字幕`)
      return { subtitles: [], cacheMaxAge: 7200 }
    }

    const translated = await translateSrt(sourceSrt, targetLang, llmApiKey, llmApiBase, llmModel)
    if (!translated) return { subtitles: [], cacheMaxAge: 3600 }

    fs.writeFileSync(cacheFile, translated, 'utf-8')
    console.log(`[llm-subtitle] 翻译完成: ${key}`)

    return {
      subtitles: [{
        id: `${key}-${targetLang}`,
        url: `${PUBLIC_URL}/srt/${key}.vtt`,
        lang: targetLang,
      }],
      cacheMaxAge: 86400 * 30,
    }
  } catch (err) {
    console.error('[llm-subtitle] 错误:', err)
    return { subtitles: [], cacheMaxAge: 3600 }
  }
})

// ---------- Express 服务器 ----------
const app = express()

// Landing page with config form (auto-redirect to /configure)
const landingHtml = landingTemplate(manifest)
app.get('/', (_, res) => res.redirect('/configure'))
app.get('/configure', (_, res) => {
  res.setHeader('content-type', 'text/html')
  res.end(landingHtml)
})

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

// 调试页面：手动测试某个 IMDb ID 的字幕搜索与翻译
app.get('/debug', (_, res) => {
  res.setHeader('content-type', 'text/html')
  res.end(`<!DOCTYPE html>
<html><body style="font-family:sans-serif;padding:20px">
<h2>AI 字幕翻译 - 调试</h2>
<form action="/debug/test" method="get">
  <p>IMDb ID: <input name="id" placeholder="tt1254207" size="30">
  <button type="submit">测试字幕搜索</button></p>
</form>
<p>配置状态：</p>
<ul>
  <li>LLM Key: ${ENV_LLM_KEY ? '已设置' : '未设置 (需在 UI 中填写)'}
  <li>OpenSubtitles Key: ${ENV_SUBS_KEY ? '已设置' : '未设置'}
  <li>API Base: ${ENV_LLM_BASE}
  <li>Model: ${ENV_LLM_MODEL}
  <li>Target: ${ENV_TARGET_LANG}
</ul>
</body></html>`)
})

app.get('/debug/test', async (req, res) => {
  res.setHeader('content-type', 'text/plain')
  const imdbId = req.query.id
  if (!imdbId) return res.end('请输入 IMDb ID')

  res.write(`测试 IMDb ID: ${imdbId}\n\n`)

  if (ENV_SUBS_KEY) {
    res.write(`[1/3] 搜索 OpenSubtitles...\n`)
    const srt = await fetchSubsByImdbId(imdbId, ENV_SUBS_KEY)
    if (srt) {
      res.write(`  找到字幕! 长度: ${srt.length} 字符\n`)
      res.write(`  前200字符: ${srt.slice(0, 200)}\n\n`)

      if (ENV_LLM_KEY) {
        res.write(`[2/3] LLM 翻译中...\n`)
        try {
          const translated = await translateSrt(srt, ENV_TARGET_LANG, ENV_LLM_KEY, ENV_LLM_BASE, ENV_LLM_MODEL)
          if (translated) {
            res.write(`  翻译完成! 长度: ${translated.length} 字符\n`)
            res.write(`  前200字符: ${translated.slice(0, 200)}\n\n`)
            res.write(`[3/3] ✅ 全部正常!\n`)
          }
        } catch (e) {
          res.write(`  ❌ 翻译失败: ${e.message}\n`)
        }
      } else {
        res.write(`[2/3] 跳过: 未配置 LLM Key\n`)
      }
    } else {
      res.write(`  ❌ 未找到字幕\n`)
    }
  } else {
    res.write(`[1/3] 跳过: 未配置 OpenSubtitles Key\n`)
    res.write(`提示: 在 Railway Dashboard → Variables 设置 OPENSUBTITLES_API_KEY\n`)
  }
  res.end()
})

// 挂载 Stremio addon 路由
app.use('/', getRouter(builder.getInterface()))

app.listen(PORT, () => {
  console.log(`AI 字幕插件运行中`)
  console.log(`  本地地址: http://127.0.0.1:${PORT}/manifest.json`)
  console.log(`  公网地址: ${PUBLIC_URL}/manifest.json`)
})
