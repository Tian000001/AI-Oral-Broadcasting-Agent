/* TTQ 口播智能体 · 静态前端（零构建原生 JS）
 * 调用后端 REST（/api/v1/*），所有响应统一信封 {status,data,message}。
 */
const API = '/api/v1';

// 字幕字体兜底列表：接口不可用时仍保证「以前的字体」可显示（与 resource/fonts 内容一致）
const FALLBACK_FONTS = [
  'STHeitiMedium.ttc', 'STHeitiLight.ttc',
  'MicrosoftYaHeiBold.ttc', 'MicrosoftYaHeiNormal.ttc',
  'BeVietnamPro-Bold.ttf', 'BeVietnamPro-Medium.ttf',
  'Charm-Bold.ttf', 'Charm-Regular.ttf', 'UTM Kabel KT.ttf'
];
const FALLBACK_DEFAULT = 'STHeitiMedium.ttc';

/* ---------------- 基础工具 ---------------- */
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(API + path, opts);
  let json;
  try { json = await res.json(); } catch (e) { throw new Error('响应解析失败'); }
  if (json && json.status === 200) return json.data;
  throw new Error((json && json.message) || ('请求失败 ' + res.status));
}

let toastTimer;
function toast(msg, isErr) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3400);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* 设置页敏感字段脱敏：按 key 名识别 API Key / 密码类字段，用 password 输入框渲染
 * （真实值仍保留在 value 中，保存时照常提交，避免误清空；仅视觉隐藏 + 可点「显示」）。*/
const SECRET_KEYS = [
  'api_keys', 'api_key', 'secret', 'secret_key', 'access_token', 'refresh_token',
  'token', 'password', 'passwd', 'speech_key', 'client_secret', 'private_key',
  'auth_token', 'bearer_token', 'credential'
];
const _secretReSrc = '(' + SECRET_KEYS.slice().sort((a, b) => b.length - a.length).join('|') + ')$';
const SECRET_RE = new RegExp(_secretReSrc, 'i');

// 根据字段 key 生成输入框：敏感字段用 password 类型 + 显示/隐藏按钮（真实值照常保留在 value）
function fieldInputHTML(sec, key, value) {
  const attrs = `data-sec="${esc(sec)}" data-key="${esc(key)}"`;
  if (SECRET_RE.test(key)) {
    return `<div class="pw"><input type="password" ${attrs} value="${esc(value)}"/>` +
           `<button type="button" class="pw-toggle">显示</button></div>`;
  }
  return `<input ${attrs} value="${esc(value)}"/>`;
}

// 绑定所有「显示/隐藏」按钮（在设置页各卡片渲染后调用一次即可）
function bindSecretReveal(root) {
  (root || document).querySelectorAll('button.pw-toggle').forEach(btn => {
    btn.onclick = () => {
      const inp = btn.parentElement && btn.parentElement.querySelector('input');
      if (!inp) return;
      if (inp.type === 'password') { inp.type = 'text'; btn.textContent = '隐藏'; }
      else { inp.type = 'password'; btn.textContent = '显示'; }
    };
  });
}

function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// 把任意返回路径归一为安全资产 URL（仅 storage/ 与 resource/ 根）
function assetUrl(p) {
  if (!p) return '';
  if (/^https?:\/\//.test(p)) return p;
  let rel = p.replace(/\\/g, '/');
  const m = rel.match(/(storage\/.*|resource\/.*)$/);
  if (m) rel = m[1];
  if (!/^(storage\/|resource\/)/.test(rel)) return '';
  return API + '/asset?path=' + encodeURIComponent(rel);
}

function stateTag(state) {
  const map = {
    '-1': ['bad', '失败'], '0': ['', '待处理'], '1': ['ok', '完成'],
    '4': ['', '处理中'], '5': ['warn', '复审'], '6': ['', '已取消'],
  };
  const [cls, label] = map[String(state)] || ['', String(state)];
  return `<span class="tag ${cls}">${label}</span>`;
}

// 渲染一条任务里的全部成片视频（video_count>1 时会有多条）。
// compact=true 用于历史/列表表格的窄单元格；否则用于生成完成后的大卡片。
function videoGallery(vids, compact) {
  if (!vids || !vids.length) return '<span class="muted">—</span>';
  return '<div class="video-wrap pill-row">' + vids.map((v, i) =>
    `<div style="${compact ? 'width:150px' : ''}">` +
      `<video src="${esc(v)}" controls${compact ? ' style="height:84px;width:auto;max-width:none"' : ''}></video>` +
      (vids.length > 1 ? `<div class="muted" style="font-size:11px;text-align:center">成片${i + 1}</div>` : '') +
      `<br><a class="btn sm" href="${esc(v)}" download>下载</a>` +
    `</div>`
  ).join('') + '</div>';
}

// 点击放大查看（封面等大图）
function openLightbox(src, caption) {
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `<img src="${esc(src)}" alt=""/><div class="cap">${esc(caption || '')}</div>`;
  lb.onclick = () => lb.remove();
  document.body.appendChild(lb);
}

/* ---------------- 侧栏导航 ---------------- */
const ICONS = {
  generate: '<path d="M128 256h512v512H128zM640 384l256-128v512z"/>',
  chars: '<path d="M512 192a160 160 0 1 0 0 320 160 160 0 0 0 0-320z m0 64c-176 0-352 88-352 256v32h704v-32c0-168-176-256-352-256z"/>',
  voices: '<path d="M512 160c70 0 128 58 128 128v192c0 70-58 128-128 128s-128-58-128-128V288c0-70 58-128 128-128z M320 480a192 192 0 0 0 384 0h-64a128 128 0 0 1-256 0z M448 800h128v-128h-128z M384 864h256v-64H384z"/>',
  dh: '<path d="M512 128a192 192 0 1 0 0 384 192 192 0 0 0 0-384z m0 96a96 96 0 1 1 0 192 96 96 0 0 1 0-192zM320 704a192 192 0 0 0-192 192v32h768v-32a192 192 0 0 0-192-192z"/>',
  reference: '<path d="M256 128h320l192 192v576H256zM544 128v192h192z"/>',
  assets: '<path d="M192 256h640a64 64 0 0 1 64 64v448a64 64 0 0 1-64 64H192a64 64 0 0 1-64-64V320a64 64 0 0 1 64-64z m0 64v282l160-160 128 128 160-160 224 224V320H192z m160 96a64 64 0 1 1 0 128 64 64 0 0 1 0-128z"/>',
  stock: '<path d="M448 128a320 320 0 1 0 195 574l161 161 64-64-161-161A320 320 0 0 0 448 128z m0 96a224 224 0 1 1 0 448 224 224 0 0 1 0-448z m-32 96h64v96h96v64h-96v96h-64v-96h-96v-64h96z"/>',
  compliance: '<path d="M512 96l320 120v280c0 220-152 360-320 440C344 856 192 716 192 496V216z"/>',
  titlecover: '<path d="M160 192h704v640H160zM256 320a64 64 0 1 0 0 128 64 64 0 0 0 0-128zM192 736l176-176 160 160 128-128 192 192z"/>',
  koucopy: '<path d="M192 224h640v96H192zM192 416h512v96H192zM192 608h384v96H192z"/>',
  koubo: '<path d="M192 256h640a64 64 0 0 1 64 64v384a64 64 0 0 1-64 64H192a64 64 0 0 1-64-64V320a64 64 0 0 1 64-64z m256 158v260l224-130z"/>',
  history: '<path d="M512 128a384 384 0 1 0 356 236l-1 1-60 36 1-1A320 320 0 1 1 512 192a312 312 0 0 1 224 94l-92 92h160V198l-70 70A384 384 0 0 0 512 128zM480 336h32v192l160 96-16 27-176-106z"/>',
  scheduler: '<path d="M256 160v96H160V160H96a64 64 0 0 0-64 64v640a64 64 0 0 0 64 64h832a64 64 0 0 0 64-64V224a64 64 0 0 0-64-64h-64v96h-96V160H256zM192 416h640v416H192z"/>',
  settings: '<path d="M320 256h384v96H320zM256 480h512v96H256zM384 704h256v96H384z"/>',
};

const NAV = [
  { id: 'koubo', label: '口播视频' },
  { id: 'koucopy', label: '口播素材' },
  { id: 'generate', label: '视频生成' },
  { id: 'chars', label: '人物管理' },
  { id: 'voices', label: '声音克隆' },
  { id: 'dh', label: '数字人生' },
  { id: 'reference', label: '对标仿写' },
  { id: 'assets', label: '资产管理' },
  { id: 'stock', label: '素材查找' },
  { id: 'compliance', label: '合规检测' },
  { id: 'titlecover', label: '标题封面' },
  { id: 'history', label: '历史任务' },
  { id: 'settings', label: '系统设置' },
];

function renderNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = NAV.map(n =>
    `<button data-view="${n.id}"><svg viewBox="0 0 1024 1024">${ICONS[n.id] || ''}</svg><span>${n.label}</span></button>`
  ).join('');
  nav.querySelectorAll('button').forEach(b => b.onclick = () => navigate(b.dataset.view));
}

// 跨 iframe 接收「口播视频工作台」全屏指令：隐藏/恢复左侧主导航栏
window.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'tv-fullscreen-toggle') return;
  const appEl = document.querySelector('.app');
  if (appEl) appEl.classList.toggle('nav-hidden', !!e.data.on);
});

let _currentView = null;
// 视频生成页「文案设置」草稿本地缓存键（防刷新/切页丢失手动修改）
const GEN_DRAFT_KEY = 'mpt_gen_draft_v1';
function navigate(view) {
  if (!view || !VIEWS[view]) view = 'generate';
  // 离开视图时恢复主导航（全屏态复位，避免卡在隐藏态）
  const appEl = document.querySelector('.app');
  if (appEl) appEl.classList.remove('nav-hidden');
  // 离开上一个视图时清理其定时器/资源。
  if (_currentView && VIEWS[_currentView] && VIEWS[_currentView].destroy) {
    try { VIEWS[_currentView].destroy(); } catch (e) {}
  }
  _currentView = view;
  document.querySelectorAll('#nav button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
  const navItem = NAV.find(n => n.id === view);
  const bc = document.getElementById('breadcrumb');
  if (bc) bc.textContent = navItem ? navItem.label : '';
  const mainEl = document.getElementById('main');
  if (mainEl) mainEl.classList.toggle('koubo-main', view === 'koubo');
  const v = VIEWS[view];
  document.getElementById('view').innerHTML = v.html();
  const extra = document.getElementById('view-extra');
  if (extra) extra.innerHTML = '';
  if (v.init) v.init();
}

/* ---------------- 各视图 ---------------- */
const VIEWS = {};

/* ===== 视频生成 ===== */
VIEWS.generate = {
  html() {
    return `
      <h1>视频生成</h1>
      <p class="sub">口播智能体端到端闭环：填主题或粘贴口播稿即可一键出片，支持字幕/配音/配乐等高级选项。</p>
        <div class="gen-grid">

          <!-- 第 1 列：文案设置 -->
          <section class="gen-col">
            <h3>文案设置</h3>
            <div class="field">
              <label>视频主题 *</label>
              <input id="video_subject" placeholder="例如：三分钟看懂碳中和" />
            </div>
            <div class="field">
              <label>对标来源（可选）</label>
              <div class="seg" id="ref_modeSeg" style="margin-bottom:10px">
                <button data-mode="paste" class="active">粘贴文案</button>
                <button data-mode="link">链接</button>
                <button data-mode="upload">上传文件</button>
              </div>
              <div id="ref_pasteBox">
                <textarea id="reference_text" placeholder="直接粘贴对标口播文案，将用于「对标仿写」生成你的口播稿"></textarea>
              </div>
              <div id="ref_linkBox" class="hidden">
                <input id="reference_link" placeholder="对标视频链接（http/https），需服务端支持下载" />
              </div>
              <div id="ref_uploadBox" class="hidden">
                <input type="file" id="reference_file" accept="video/*,audio/*" />
                <p class="muted" id="reference_uploadHint" style="margin:6px 0 0">选择视频/音频后自动上传到服务器并转写（支持 mp4/mov/mkv/webm/avi/mp3/wav 等）</p>
              </div>
            </div>
            <div class="field">
              <label>人设（Persona）</label>
              <select id="persona_id"><option value="">不指定</option></select>
            </div>
            <div class="field">
              <label>生成视频脚本的语言</label>
              <select id="video_language">
                <option value="">自动检测</option>
                <option value="zh-CN">中文</option>
                <option value="en-US">英文</option>
                <option value="ja-JP">日文</option>
                <option value="ko-KR">韩文</option>
              </select>
            </div>
            <div class="pill-row" style="gap:8px;margin-bottom:10px">
              <button class="btn sm" id="aiGenScriptBtn" type="button">AI生成</button>
              <button class="btn sm ghost" id="aiGenTermsBtn" type="button">合规检测</button>
            </div>
            <div class="rprog-wrap hidden" id="aiGenProg">
              <div class="rprog-stage" id="aiGenStage">准备中…</div>
              <div class="rprog"><div class="rprog-bar" id="aiGenBar"></div></div>
              <div class="rprog-pct" id="aiGenPct">0%</div>
            </div>
            <div class="compliance-box hidden" id="complianceResult"></div>
            <div class="field">
              <label style="display:flex;align-items:center;justify-content:space-between;gap:10px">
                <span>口播文案（可选，留空自动生成）</span>
                <button class="btn sm ghost" id="clearDraftBtn" type="button">清空草稿</button>
              </label>
              <textarea id="video_script" placeholder="可直接粘贴对标仿写稿或自定义文案"></textarea>
              <small id="draftStatus" class="muted" style="display:block;margin-top:4px"></small>
            </div>
            <div class="field">
              <label>视频关键词（可选，逗号分隔）</label>
              <textarea id="video_terms" placeholder="留空自动生成；也可点击上方按钮由 AI 生成"></textarea>
            </div>
          </section>

          <!-- 第 2 列：视频设置 -->
          <section class="gen-col">
            <h3>视频设置</h3>
            <div class="field"><label>画面比例</label>
              <select id="video_aspect"><option value="9:16">竖屏 9:16</option><option value="16:9">横屏 16:9</option><option value="1:1">正方形 1:1</option></select>
            </div>
            <div class="field"><label>生成条数</label><input id="video_count" type="number" value="1" min="1" /></div>
            <div class="field"><label>素材来源</label>
              <select id="video_source"><option value="pexels">Pexels</option><option value="local">本地(local_videos)</option></select>
            </div>
            <div class="field" id="localAssetWrap" style="display:none">
              <label>本地素材视频（从资产管理选择）</label>
              <div id="localAssetList" class="localAssetGrid"></div>
              <p class="muted" style="font-size:12px;margin-top:6px">勾选后将从「资产管理 → 视频」中选用这些视频作为素材（含预览图）；不勾选则使用 storage/local_videos 目录下的全部素材。</p>
            </div>
            <div class="field"><label>拼接模式</label>
              <select id="video_concat_mode"><option value="random">随机拼接</option><option value="sequential">顺序拼接</option></select>
            </div>
            <div class="field"><label>转场效果</label>
              <select id="video_transition_mode"><option value="">无</option><option value="Shuffle">随机</option><option value="FadeIn">淡入</option><option value="FadeOut">淡出</option><option value="SlideIn">滑入</option><option value="SlideOut">滑出</option><option value="ZoomIn">放大进入</option><option value="ZoomOut">缩小退出</option></select>
            </div>
            <div class="field"><label>单个片段最大时长(秒)</label><input id="video_clip_duration" type="number" value="5" min="1" /></div>
            <div class="field"><label>片段播放速度</label><input id="video_clip_speed" type="number" value="1.0" step="0.1" min="0.1" /></div>
          </section>

          <!-- 第 3 列：音频设置 -->
          <section class="gen-col">
            <h3>音频设置</h3>
            <div class="field"><label>配音方式</label>
              <select id="voice_mode">
                <option value="tts">自动配音</option>
                <option value="upload">上传音频</option>
                <option value="none">无配音</option>
              </select>
            </div>
            <div class="field"><label>配音服务(TTS)</label>
              <select id="tts_server"><option value="">默认</option></select>
            </div>
            <div id="customAudioWrap" class="hidden" style="margin-top:10px">
              <div class="field" style="max-width:560px">
                <label>自定义配音文件（mp3/wav）</label>
                <div class="pill-row" style="gap:10px;align-items:center;flex-wrap:wrap">
                  <input type="file" id="customAudioFile" accept="audio/*" />
                  <button class="btn sm" id="customAudioUploadBtn" type="button">上传</button>
                </div>
                <p class="muted" id="customAudioHint" style="margin-top:6px"></p>
                <input type="hidden" id="custom_audio_file" />
              </div>
            </div>
            <div class="pill-row" style="gap:8px;margin-bottom:10px;align-items:center">
              <button class="btn sm" id="previewVoiceBtn" type="button">试听音色</button>
              <button class="btn sm ghost" id="previewFullBtn" type="button">完整试听</button>
              <audio id="voicePreview" controls style="height:32px;max-width:200px;display:none"></audio>
            </div>
            <div class="field"><label>配音音色</label><select id="voice_name"><option value="">默认音色</option></select></div>
            <div class="field"><label>配音音量(0–2)</label><input id="voice_volume" type="number" value="1.0" step="0.1" min="0" max="2" /></div>
            <div class="field"><label>配音语速(0.5–2)</label><input id="voice_rate" type="number" value="1.0" step="0.1" min="0.5" max="2" /></div>
            <p class="muted" style="font-size:12px">提示：语调(pitch)后端暂未实现，后续版本补充。</p>
            <div class="field"><label>背景音乐</label>
              <select id="bgm_type"><option value="random">随机</option><option value="none">无</option><option value="custom">自定义</option></select>
            </div>
            <div id="bgmCustomWrap" class="hidden" style="margin-top:10px">
              <div class="field" style="max-width:560px">
                <label>自定义背景音乐文件（mp3）</label>
                <div class="pill-row" style="gap:10px;align-items:center;flex-wrap:wrap">
                  <input type="file" id="bgmFile" accept="audio/*" />
                  <button class="btn sm" id="bgmUploadBtn" type="button">上传</button>
                </div>
                <p class="muted" id="bgmFileHint" style="margin-top:6px"></p>
                <input type="hidden" id="bgm_file" />
              </div>
            </div>
            <div class="field"><label>背景音乐音量(0–1)</label><input id="bgm_volume" type="number" value="0.2" step="0.05" min="0" max="1" style="max-width:220px" /></div>
            <div class="field"><label>BGM 提示词（Sonilo / ElevenLabs 配乐）</label><textarea id="video_music_prompt" placeholder="描述想要的配乐风格，例如：轻快电子节奏"></textarea></div>
          </section>

          <!-- 第 4 列：字幕设置 -->
          <section class="gen-col">
            <h3>字幕设置</h3>
            <div class="field"><label style="cursor:pointer"><input type="checkbox" id="subtitle_enabled" checked style="width:auto;margin-right:6px;vertical-align:middle" />启用字幕</label></div>
            <div class="field"><label>字幕位置</label>
              <select id="subtitle_position"><option value="bottom">底部</option><option value="top">顶部</option><option value="center">居中</option><option value="custom">自定义</option></select>
            </div>
            <div class="field" id="customPosWrap" style="display:none"><label>自定义位置(%)</label><input id="custom_position" type="number" value="70" min="0" max="100" /></div>
            <div class="field"><label>字号</label><input id="font_size" type="number" value="60" min="10" /></div>
            <div class="field"><label>字体</label><select id="font_name"></select></div>
            <div class="field"><label>文字颜色</label><input id="text_fore_color" type="color" value="#FFFFFF" style="height:38px;padding:2px" /></div>
            <div class="field"><label>描边颜色</label><input id="stroke_color" type="color" value="#000000" style="height:38px;padding:2px" /></div>
            <div class="field"><label>描边宽度</label><input id="stroke_width" type="number" value="1.5" step="0.1" min="0" /></div>
            <div class="field"><label style="cursor:pointer"><input type="checkbox" id="text_background_color" style="width:auto;margin-right:6px;vertical-align:middle" />字幕背景填充</label></div>
            <div class="field"><label style="cursor:pointer"><input type="checkbox" id="rounded_subtitle_background" style="width:auto;margin-right:6px;vertical-align:middle" />字幕背景圆角</label></div>
            <button class="btn sm ghost" id="resetSubtitleBtn" type="button" style="margin-top:6px">恢复默认字幕设置</button>
          </section>

        </div>
        <button class="btn gen-submit" id="genBtn">生成视频</button>
      <div id="genProgress" class="hidden card" style="margin-top:16px"></div>
      <div style="margin-top:28px;display:flex;align-items:center;justify-content:space-between">
        <h2 style="margin:0;font-size:17px">最近生成任务</h2>
        <button class="btn sm ghost" id="gotoHistory" type="button">查看全部历史任务 →</button>
      </div>
      <div id="taskList" class="card" style="margin-top:8px"></div>
    `;
  },
  init() {
    // 无脸混剪模式已移除，本页仅保留口播智能体生成；人设/对标字段默认展开。
    // 填充人设下拉
    api('GET', '/agent/personas').then(list => {
      this._personas = list || [];
      const sel = document.getElementById('persona_id');
      (list || []).forEach(p => {
        const o = document.createElement('option');
        o.value = p.id; o.textContent = p.name || p.id; sel.appendChild(o);
      });
    }).catch(() => { this._personas = []; });

    // BGM 自定义上传联动
    const bgmType = document.getElementById('bgm_type');
    const bgmWrap = document.getElementById('bgmCustomWrap');
    bgmType.onchange = () => bgmWrap.classList.toggle('hidden', bgmType.value !== 'custom');
    document.getElementById('bgmUploadBtn').onclick = () => this.uploadBgm();
    // 字幕位置 → 自定义位置显隐
    document.getElementById('subtitle_position').onchange = (e) => {
      document.getElementById('customPosWrap').style.display = (e.target.value === 'custom') ? '' : 'none';
    };

    // 填充字幕字体下拉（动态列举 resource/fonts 目录；接口失败时用兜底列表）
    this.populateFonts();

    // 素材来源=本地 时展开「从资产管理选视频」多选
    this._localAssetSel = new Set();
    this._localAssetMap = {};
    document.getElementById('video_source').onchange = (e) => {
      const isLocal = e.target.value === 'local';
      document.getElementById('localAssetWrap').style.display = isLocal ? '' : 'none';
      if (isLocal) this.loadLocalAssets();
    };
    if (document.getElementById('video_source').value === 'local') {
      document.getElementById('localAssetWrap').style.display = '';
      this.loadLocalAssets();
    }

    // 对标来源三选一：粘贴文案 / 链接 / 上传文件（显式模式，避免纯文本被误判为 source）
    this._refUploadedPath = null;
    const refSeg = document.getElementById('ref_modeSeg');
    if (refSeg) {
      refSeg.querySelectorAll('button').forEach(b => b.onclick = () => {
        refSeg.querySelectorAll('button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        const m = b.dataset.mode;
        document.getElementById('ref_pasteBox').classList.toggle('hidden', m !== 'paste');
        document.getElementById('ref_linkBox').classList.toggle('hidden', m !== 'link');
        document.getElementById('ref_uploadBox').classList.toggle('hidden', m !== 'upload');
      });
    }
    const refFile = document.getElementById('reference_file');
    if (refFile) refFile.onchange = async () => {
      const hint = document.getElementById('reference_uploadHint');
      if (!refFile.files.length) { this._refUploadedPath = null; return; }
      hint.textContent = '上传中…';
      const fd = new FormData();
      fd.append('file', refFile.files[0]);
      fd.append('category', 'misc');
      try {
        const r = await fetch(API + '/upload', { method: 'POST', body: fd });
        const j = await r.json();
        if (j && j.status === 200) {
          this._refUploadedPath = j.data.path;
          hint.textContent = '已上传：' + j.data.file + '（点击「开始生成」转写并仿写）';
        } else {
          this._refUploadedPath = null;
          hint.textContent = '上传失败：' + ((j && j.message) || '未知错误');
        }
      } catch (e) {
        this._refUploadedPath = null;
        hint.textContent = '上传失败：' + e.message;
      }
    };

    document.getElementById('genBtn').onclick = () => this.submit();
    const gotoH = document.getElementById('gotoHistory');
    if (gotoH) gotoH.onclick = () => navigate('history');

    // —— Step 3：列内联动 ——
    // 配音方式：upload→显示上传控件；none→禁用配音字段；tts→正常可用
    const vm = document.getElementById('voice_mode');
    const customAudioWrap = document.getElementById('customAudioWrap');
    const voiceFields = ['voice_name', 'voice_volume', 'voice_rate'].map(id => document.getElementById(id));
    const applyVoiceMode = () => {
      const m = vm.value;
      customAudioWrap.classList.toggle('hidden', m !== 'upload');
      const disable = (m === 'none');
      voiceFields.forEach(el => { if (el) el.disabled = disable; });
    };
    vm.onchange = applyVoiceMode;
    document.getElementById('customAudioUploadBtn').onclick = () => this.uploadCustomAudio();
    applyVoiceMode();

    // 配音服务：从后端拉取可用 TTS 服务列表，并联动音色下拉
    api('GET', '/agent/tts/services').then(res => {
      const services = (res && res.services) || [];
      this._ttsServices = services;
      const ttsSel = document.getElementById('tts_server');
      services.forEach(s => {
        const o = document.createElement('option');
        o.value = s.id; o.textContent = s.label;
        if (s.planned) o.disabled = true;
        ttsSel.appendChild(o);
      });
      const curSvc = (res && res.current_service) || '';
      if (curSvc) ttsSel.value = curSvc;
      this.populateVoices(ttsSel.value);
      const curVoice = (res && res.current_voice) || '';
      if (curVoice) {
        const vSel = document.getElementById('voice_name');
        const hit = [...vSel.options].find(o => o.value === curVoice);
        if (hit) vSel.value = curVoice;
      }
    }).catch(() => {});
    // 切换配音服务商 → 重新填充对应音色（联动）
    document.getElementById('tts_server').onchange = () => {
      this.populateVoices(document.getElementById('tts_server').value);
    };

    // AI 辅助按钮
    document.getElementById('aiGenScriptBtn').onclick = () => this.aiGenerateScript();
    document.getElementById('aiGenTermsBtn').onclick = () => this.complianceCheck();
    document.getElementById('previewVoiceBtn').onclick = () => this.previewVoice(false);
    document.getElementById('previewFullBtn').onclick = () => this.previewVoice(true);
    document.getElementById('resetSubtitleBtn').onclick = () => this.resetSubtitle();

    // 加载默认配置（回填字幕/配音默认值）
    api('GET', '/config').then(cfg => {
      const ui = (cfg && cfg.ui) || {};
      if (ui.subtitle_position) document.getElementById('subtitle_position').value = ui.subtitle_position;
      if (ui.custom_position != null) document.getElementById('custom_position').value = ui.custom_position;
      this._savedFontName = ui.font_name || 'STHeitiMedium.ttc';
      this.applyFontSelection();
      if (ui.voice_mode) document.getElementById('voice_mode').value = ui.voice_mode;
      applyVoiceMode();
    }).catch(() => {});

    this.loadTasks().then(() => this._restoreLatestVideo());

    // —— 口播文案草稿：恢复 + 自动保存 ——
    this._restoreDraft();
    this._bindDraftAutosave();
    const clearBtn = document.getElementById('clearDraftBtn');
    if (clearBtn) clearBtn.onclick = () => this.clearDraft();
  },
  // —— 口播文案草稿：本地自动保存（localStorage，防刷新/切页丢失）——
  _restoreDraft() {
    try {
      const raw = localStorage.getItem(GEN_DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      const set = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
      set('video_subject', d.subject);
      set('reference_text', d.reference);
      set('video_script', d.script);
      set('video_terms', d.terms);
      const st = document.getElementById('draftStatus');
      if (st && d.savedAt) st.textContent = '已恢复上次草稿（' + new Date(d.savedAt).toLocaleString() + '）';
    } catch (e) { /* 草稿损坏则忽略 */ }
  },
  _bindDraftAutosave() {
    const fields = ['video_subject', 'reference_text', 'video_script', 'video_terms'];
    let timer = null;
    const save = () => {
      const d = {
        subject: document.getElementById('video_subject').value,
        reference: document.getElementById('reference_text').value,
        script: document.getElementById('video_script').value,
        terms: document.getElementById('video_terms').value,
        savedAt: Date.now(),
      };
      try {
        localStorage.setItem(GEN_DRAFT_KEY, JSON.stringify(d));
        const st = document.getElementById('draftStatus');
        if (st) st.textContent = '草稿已自动保存 · ' + new Date(d.savedAt).toLocaleTimeString();
      } catch (e) { /* 存储不可用时静默 */ }
    };
    fields.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(save, 700);
      });
    });
  },
  clearDraft() {
    try { localStorage.removeItem(GEN_DRAFT_KEY); } catch (e) {}
    ['video_subject', 'reference_text', 'video_script', 'video_terms'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    const st = document.getElementById('draftStatus');
    if (st) st.textContent = '';
    toast('草稿已清空');
  },
  async submit() {
    const subject = document.getElementById('video_subject').value.trim();
    if (!subject) { toast('请填写视频主题', true); return; }
    const mode = 'koubo';
    const body = {
      video_subject: subject,
      video_script: document.getElementById('video_script').value,
      video_aspect: document.getElementById('video_aspect').value,
      video_count: parseInt(document.getElementById('video_count').value) || 1,
      video_source: document.getElementById('video_source').value,
      voice_name: document.getElementById('voice_name').value,
      bgm_type: document.getElementById('bgm_type').value,
    };
    // P0 高级选项：字幕 / 配音 / 配乐
    const lang = document.getElementById('video_language').value;
    if (lang) body.video_language = lang;
    body.subtitle_enabled = document.getElementById('subtitle_enabled').checked;
    body.subtitle_position = document.getElementById('subtitle_position').value;
    if (body.subtitle_position === 'custom') body.custom_position = parseFloat(document.getElementById('custom_position').value) || 70;
    body.font_name = document.getElementById('font_name').value;
    body.font_size = parseInt(document.getElementById('font_size').value) || 60;
    body.text_fore_color = document.getElementById('text_fore_color').value;
    body.stroke_color = document.getElementById('stroke_color').value;
    body.stroke_width = parseFloat(document.getElementById('stroke_width').value) || 1.5;
    body.text_background_color = document.getElementById('text_background_color').checked;
    body.rounded_subtitle_background = document.getElementById('rounded_subtitle_background').checked;
    body.voice_volume = parseFloat(document.getElementById('voice_volume').value) || 1.0;
    body.voice_rate = parseFloat(document.getElementById('voice_rate').value) || 1.0;
    const bgmVol = parseFloat(document.getElementById('bgm_volume').value);
    if (!isNaN(bgmVol)) body.bgm_volume = bgmVol;
    const bgmPrompt = document.getElementById('video_music_prompt').value.trim();
    if (bgmPrompt) body.video_music_prompt = bgmPrompt;
    if (document.getElementById('bgm_type').value === 'custom') {
      const bgmFile = document.getElementById('bgm_file').value;
      if (!bgmFile) { toast('请先上传自定义背景音乐文件', true); return; }
      body.bgm_file = bgmFile;
    }
    // P1 剪辑参数：拼接模式 / 转场 / 单镜头时长 / 素材速度
    const concatMode = document.getElementById('video_concat_mode').value;
    if (concatMode) body.video_concat_mode = concatMode;
    const transMode = document.getElementById('video_transition_mode').value;
    if (transMode) body.video_transition_mode = transMode;
    const clipDur = parseInt(document.getElementById('video_clip_duration').value);
    if (!isNaN(clipDur)) body.video_clip_duration = clipDur;
    const clipSpeed = parseFloat(document.getElementById('video_clip_speed').value);
    if (!isNaN(clipSpeed)) body.video_clip_speed = clipSpeed;
    // 本地素材：若用户从资产管理勾选了视频，则作为 video_materials 传入，仅使用这些素材
    if (document.getElementById('video_source').value === 'local' && this._localAssetSel && this._localAssetSel.size) {
      const mats = [];
      this._localAssetSel.forEach(id => {
        const m = this._localAssetMap[id];
        if (m && m.exists) mats.push({ provider: 'local', url: m.url, duration: 0 });
      });
      if (mats.length) body.video_materials = mats;
    }
    if (mode === 'koubo') {
      body.agent_mode = 'koubo';
      const pid = document.getElementById('persona_id').value;
      if (pid) body.persona_id = pid;
      // 对标来源三选一：粘贴文案→transcript_text（显式，不做 source 误判）；
      // 链接/上传→reference_source（路径/URL）。
      const refSeg = document.querySelector('#ref_modeSeg .active');
      const refMode = refSeg ? refSeg.dataset.mode : 'paste';
      if (refMode === 'paste') {
        const t = document.getElementById('reference_text').value.trim();
        if (t) body.transcript_text = t;
      } else if (refMode === 'link') {
        const l = document.getElementById('reference_link').value.trim();
        if (l) body.reference_source = l;
      } else { // upload
        if (this._refUploadedPath) body.reference_source = this._refUploadedPath;
        else if (document.getElementById('reference_file').files.length) { toast('请等待对标文件上传完成', true); return; }
      }
    }
    // 视频关键词
    const terms = document.getElementById('video_terms').value.trim();
    if (terms) body.video_terms = terms;
    // 配音方式 / 配音服务：前端展示态持久化与任务还原用；真实 TTS 路由
    // 仍由 voice_name 前缀决定。voice_mode='none' 时把 voice_name 置为
    // 静音哨兵 'none'，后端 is_no_voice 走静音分支（不合成真实语音）。
    const voiceMode = document.getElementById('voice_mode').value;
    if (voiceMode) body.voice_mode = voiceMode;
    const ttsServer = document.getElementById('tts_server').value;
    if (ttsServer) body.tts_server = ttsServer;
    if (voiceMode === 'none') {
      body.voice_name = 'none';
    } else if (voiceMode === 'upload') {
      const caf = document.getElementById('custom_audio_file').value;
      if (!caf) { toast('请先上传自定义配音文件', true); return; }
      body.custom_audio_file = caf;
    } else {
      // TTS 模式：未选音色时兜底为已验证可用的免费微软音色，
      // 避免 body.voice_name 为空导致后端 Invalid voice '' 合成失败
      if (!body.voice_name) body.voice_name = 'zh-CN-XiaoxiaoNeural';
    }
    const btn = document.getElementById('genBtn');
    btn.disabled = true;
    try {
      const data = await api('POST', '/videos', body);
      toast('任务已创建，开始生成');
      this.poll(data.task_id);
      this.loadTasks();
      // 生成成功后清除本地草稿（内容已存入任务），保留可见字段便于微调重提
      try { localStorage.removeItem(GEN_DRAFT_KEY); } catch (e) {}
      const st = document.getElementById('draftStatus');
      if (st) st.textContent = '';
    } catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; }
  },
  async uploadBgm() {
    const inp = document.getElementById('bgmFile');
    if (!inp.files.length) { toast('请先选择音频文件', true); return; }
    const fd = new FormData();
    fd.append('file', inp.files[0]);
    fd.append('category', 'misc');
    try {
      const r = await fetch(API + '/upload', { method: 'POST', body: fd });
      const j = await r.json();
      if (j && j.status === 200) {
        document.getElementById('bgm_file').value = j.data.path;
        document.getElementById('bgmFileHint').textContent = '已上传：' + j.data.file;
        toast('背景音乐已上传');
      } else { toast((j && j.message) || '上传失败', true); }
    } catch (e) { toast(e.message, true); }
  },
  async uploadCustomAudio() {
    const inp = document.getElementById('customAudioFile');
    if (!inp.files.length) { toast('请先选择音频文件', true); return; }
    const fd = new FormData();
    fd.append('file', inp.files[0]);
    fd.append('category', 'misc');
    try {
      const r = await fetch(API + '/upload', { method: 'POST', body: fd });
      const j = await r.json();
      if (j && j.status === 200) {
        document.getElementById('custom_audio_file').value = j.data.path;
        document.getElementById('customAudioHint').textContent = '已上传：' + j.data.file;
        toast('配音音频已上传');
      } else { toast((j && j.message) || '上传失败', true); }
    } catch (e) { toast(e.message, true); }
  },
  // 判断「对标来源」当前模式是否已有内容（粘贴文案 / 链接 / 已上传文件）
  getReferencePayload() {
    const refSeg = document.querySelector('#ref_modeSeg .active');
    const mode = refSeg ? refSeg.dataset.mode : 'paste';
    if (mode === 'paste') {
      const t = document.getElementById('reference_text').value.trim();
      return { mode, hasContent: !!t, transcript_text: t };
    }
    if (mode === 'link') {
      const l = document.getElementById('reference_link').value.trim();
      return { mode, hasContent: !!l, reference_source: l };
    }
    // upload
    const uploaded = this._refUploadedPath;
    const filePending = document.getElementById('reference_file').files.length > 0 && !uploaded;
    return { mode, hasContent: !!uploaded, reference_source: uploaded, filePending };
  },
  // AI 生成进度条驱动
  showAIProgress() {
    const wrap = document.getElementById('aiGenProg');
    if (wrap) wrap.classList.remove('hidden');
    this.setAIProgress(6, '准备中…');
  },
  setAIProgress(pct, stage) {
    pct = Math.max(0, Math.min(100, pct));
    const bar = document.getElementById('aiGenBar');
    const st = document.getElementById('aiGenStage');
    const pc = document.getElementById('aiGenPct');
    if (bar) bar.style.width = pct + '%';
    if (st) st.textContent = stage || '';
    if (pc) pc.textContent = pct + '%';
  },
  hideAIProgress(delayMs = 0) {
    const wrap = document.getElementById('aiGenProg');
    if (!wrap) return;
    const hide = () => wrap.classList.add('hidden');
    if (delayMs > 0) setTimeout(hide, delayMs);
    else hide();
  },
  async aiGenerateScript() {
    const subjectEl = document.getElementById('video_subject');
    const subject = subjectEl.value.trim();
    const personaId = document.getElementById('persona_id').value;
    const ref = this.getReferencePayload();
    const btn = document.getElementById('aiGenScriptBtn');

    // ── 对标来源有内容：走「对标仿写」链路 ──
    // 对标仿写会基于对标转写做语义级仿写，并融合人设口吻（persona_id），
    // 从而「对标内容 + 人设」两者结合，而不是由人设单独主导。
    if (ref.hasContent) {
      if (ref.filePending) { toast('请等待对标文件上传完成', true); return; }
      btn.disabled = true;
      this.showAIProgress();
      this.setAIProgress(10, '正在处理对标内容…');
      try {
        const body = {};
        if (ref.mode === 'paste') body.transcript_text = ref.transcript_text;
        else body.source = ref.reference_source;          // link / upload 走 source
        if (personaId) body.persona_id = personaId;        // 融合人设口吻
        const lang = document.getElementById('video_language').value;
        if (lang) body.language = lang;
        const rewritten = await this.consumeReferenceSSE(body);
        if (rewritten) {
          document.getElementById('video_script').value = rewritten;
          this.setAIProgress(80, '仿写口播稿已生成，正在生成关键词…');
          const tb = await api('POST', '/llm/terms', { video_subject: subject, video_script: rewritten });
          if (tb && tb.video_terms) {
            const terms = Array.isArray(tb.video_terms) ? tb.video_terms.join('，') : tb.video_terms;
            document.getElementById('video_terms').value = terms;
            this.setAIProgress(100, '对标仿写完成，文案与关键词已生成 ✓');
            toast('对标仿写完成，文案与关键词已生成');
          } else {
            this.setAIProgress(100, '仿写完成，但关键词生成失败');
            toast('仿写完成，关键词生成失败', true);
          }
        }
        // rewritten 为空时 consumeReferenceSSE 已置 100% 并 toast 错误
      } catch (e) {
        this.setAIProgress(100, '生成失败：' + e.message);
        toast(e.message, true);
      }
      finally {
        btn.disabled = false;
        setTimeout(() => this.hideAIProgress(), 1800);
      }
      return;
    }

    // ── 对标来源无内容：原逻辑（可选自动生成主题 → /llm/scripts → /llm/terms）──
    // 主题是否必填：有对标来源 或 指定了人设 时，主题非必填；两者皆无才必须填主题
    const hasPersona = !!personaId;
    if (!subject) {
      if (!hasPersona) {
        // 规则2：人设不指定 + 无对标来源 → 必须填主题
        toast('请填写视频主题，或指定人设 / 提供对标来源', true);
        return;
      }
      // 规则1：无主题 + 有人设 → 根据人设自动生成一条主题
      const p = (this._personas || []).find(x => x.id === personaId);
      btn.disabled = true;
      this.showAIProgress();
      this.setAIProgress(18, '正在生成主题…');
      try {
        const t = await api('POST', '/llm/topic', {
          persona_name: p ? p.name : '',
          persona_tone: p ? p.tone : '',
          video_language: document.getElementById('video_language').value,
        });
        if (t && t.video_subject) {
          subjectEl.value = t.video_subject;
          this.setAIProgress(35, '已根据人设生成主题，正在生成文案…');
        } else {
          this.setAIProgress(100, '自动生成主题失败，请填写视频主题');
          toast('自动生成主题失败，请填写视频主题', true);
          setTimeout(() => this.hideAIProgress(), 2000);
          return;
        }
      } catch (e) {
        this.setAIProgress(100, '生成主题失败：' + e.message);
        toast(e.message, true);
        setTimeout(() => this.hideAIProgress(), 2000);
        return;
      }
      finally { btn.disabled = false; }
    }

    // 生成文案 + 关键词（注入人设语吻，贴合人设语气）
    const realSubject = subjectEl.value.trim();
    if (!realSubject) { toast('请先填写视频主题', true); return; }
    btn.disabled = true;
    this.showAIProgress();
    try {
      const lang = document.getElementById('video_language').value;
      const p = (this._personas || []).find(x => x.id === personaId);
      const customSystemPrompt = (p && (p.name || p.tone))
        ? `你是一个名为「${p.name || '未命名'}」的短视频口播博主。口吻要求：${p.tone || '自然亲切'}。请严格贴合该人设的语气与定位撰写口播文案。`
        : '';
      this.setAIProgress(55, '正在生成口播文案…');
      const sb = await api('POST', '/llm/scripts', {
        video_subject: realSubject,
        video_language: lang,
        custom_system_prompt: customSystemPrompt,
      });
      if (sb && sb.video_script) {
        document.getElementById('video_script').value = sb.video_script;
        this.setAIProgress(78, '文案已生成，正在生成关键词…');
        const tb = await api('POST', '/llm/terms', { video_subject: realSubject, video_script: sb.video_script });
        if (tb && tb.video_terms) {
          const terms = Array.isArray(tb.video_terms) ? tb.video_terms.join('，') : tb.video_terms;
          document.getElementById('video_terms').value = terms;
          this.setAIProgress(100, '文案与关键词已生成 ✓');
          toast('文案与关键词已生成');
        } else {
          this.setAIProgress(100, '文案已生成，但关键词生成失败');
          toast('文案已生成，关键词生成失败', true);
        }
      } else {
        this.setAIProgress(100, '生成文案失败');
        toast('生成文案失败', true);
      }
    } catch (e) {
      this.setAIProgress(100, '生成失败：' + e.message);
      toast(e.message, true);
    }
    finally {
      btn.disabled = false;
      setTimeout(() => this.hideAIProgress(), 1800);
    }
  },
  // 消费对标仿写 SSE 流：POST /agent/reference/process，返回仿写口播稿；失败返回 null
  async consumeReferenceSSE(body) {
    const res = await fetch(API + '/agent/reference/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const j = await res.json().catch(() => ({}));
      throw new Error((j && j.message) || ('请求失败 ' + res.status));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let rewritten = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        let evt;
        try { evt = JSON.parse(dataLine.slice(6)); } catch { continue; }
        if (evt.type === 'progress') {
          this.setAIProgress(evt.pct, evt.msg);
        } else if (evt.type === 'done') {
          const d = evt.data || {};
          rewritten = d.rewritten_script || '';
          this.setAIProgress(70, '仿写完成，正在填入文案…');
        } else if (evt.type === 'error') {
          this.setAIProgress(100, '对标处理失败：' + (evt.message || '未知错误'));
          toast('对标处理失败：' + (evt.message || '未知错误'), true);
          return null;
        }
      }
    }
    if (!rewritten) {
      this.setAIProgress(100, '仿写未返回内容');
      toast('对标仿写未返回口播稿', true);
      return null;
    }
    return rewritten;
  },
  async complianceCheck() {
    const script = document.getElementById('video_script').value.trim();
    const subject = document.getElementById('video_subject').value.trim();
    const terms = document.getElementById('video_terms').value.trim();
    const lang = document.getElementById('video_language').value;
    if (!script) {
      toast('请先填写或生成口播文案，再做合规检测', true);
      return;
    }
    const btn = document.getElementById('aiGenTermsBtn');
    btn.disabled = true;
    const box = document.getElementById('complianceResult');
    try {
      const r = await api('POST', '/llm/compliance', {
        video_script: script,
        video_subject: subject,
        video_terms: terms,
        video_language: lang,
      });
      this.renderCompliance(r || {});
    } catch (e) {
      box.classList.remove('hidden');
      box.innerHTML = `<div class="compliance-summary lv-medium">合规检测失败：${e.message}</div>`;
      toast('合规检测失败：' + e.message, true);
    }
    finally { btn.disabled = false; }
  },

  // 渲染合规检测结果：总体结论 + 分级风险列表
  renderCompliance(r) {
    const box = document.getElementById('complianceResult');
    box.classList.remove('hidden');
    const passed = !!r.passed;
    const summary = (r.summary || (passed ? '未发现明显合规风险' : '发现合规风险，请查看明细')).replace(/</g, '&lt;');
    const issues = Array.isArray(r.issues) ? r.issues : [];
    const lvClass = passed ? 'lv-ok' : 'lv-high';
    const head = `<div class="compliance-summary ${lvClass}">${passed ? '✓ 合规通过' : '⚠ 检测到风险'} · ${summary}</div>`;
    if (!issues.length) {
      box.innerHTML = head + '<div class="compliance-empty">未列出具体风险项。</div>';
      return;
    }
    const lvLabel = { high: '高风险', medium: '中风险', low: '建议优化' };
    const items = issues.map((it) => {
      const lv = (it.level === 'high' || it.level === 'medium' || it.level === 'low') ? it.level : 'low';
      const cat = String(it.category || '其他').replace(/</g, '&lt;');
      const matched = String(it.matched || '').replace(/</g, '&lt;');
      const suggestion = String(it.suggestion || '').replace(/</g, '&lt;');
      return `<div class="compliance-item lv-${lv}">
        <div class="ci-head"><span class="ci-tag lv-${lv}">${lvLabel[lv]}</span><span class="ci-cat">${cat}</span></div>
        ${matched ? `<div class="ci-matched">命中：「${matched}」</div>` : ''}
        ${suggestion ? `<div class="ci-sug">建议：${suggestion}</div>` : ''}
      </div>`;
    }).join('');
    box.innerHTML = head + `<div class="compliance-list">${items}</div>`;
  },
  // 根据所选 TTS 服务，填充配音音色下拉。
  // 注意：后端 /agent/tts/services 返回的 voices 已是「可直接用于 tts() 路由」的
  // 完整音色标识——非 Azure 服务自带前缀（如 minimax:xxx、chatterbox:default），
  // Azure 为裸名（如 zh-CN-XiaoxiaoNeural-Female，默认路由到 azure_tts_v1）。
  // 因此此处直接使用后端值，切勿再加前缀，否则会重复前缀导致路由失败。
  populateVoices(serviceId) {
    const sel = document.getElementById('voice_name');
    sel.innerHTML = '<option value="">默认音色</option>';
    if (!serviceId) return;
    const svc = (this._ttsServices || []).find(s => s.id === serviceId);
    if (!svc || !Array.isArray(svc.voices) || !svc.voices.length) return;
    svc.voices.forEach(v => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      sel.appendChild(o);
    });
    // 默认选中第一个真实音色，保证「试听」开箱即用
    const first = [...sel.options].find(o => o.value);
    if (first) sel.value = first.value;
  },
  async previewVoice(full) {
    const voiceName = document.getElementById('voice_name').value.trim();
    if (!voiceName) { toast('请先填写配音音色', true); return; }
    const text = full
      ? (document.getElementById('video_script').value.trim() || '这是一段完整试听，用于预览当前文案的配音效果。')
      : '你好，这是一段试听音频。';
    const service = document.getElementById('tts_server').value || 'azure-tts-v1';
    const btn = document.getElementById(full ? 'previewFullBtn' : 'previewVoiceBtn');
    btn.disabled = true;
    try {
      const r = await api('POST', '/agent/tts/preview', {
        voice_name: voiceName,
        service: service,
        text: text,
        volume: parseFloat(document.getElementById('voice_volume').value) || 1.0,
        rate: parseFloat(document.getElementById('voice_rate').value) || 1.0,
      });
      const au = document.getElementById('voicePreview');
      if (r && r.audio_url) {
        au.src = r.audio_url; au.style.display = '';
        au.play().catch(() => {});
        toast('试听已生成');
      } else { toast('试听生成失败', true); }
    } catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; }
  },
  populateFonts() {
    const sel = document.getElementById('font_name');
    if (!sel) return;
    const build = (fonts, def) => {
      sel.innerHTML = '';
      fonts.forEach(f => {
        const o = document.createElement('option');
        o.value = f; o.textContent = f; sel.appendChild(o);
      });
      this._defaultFont = def || 'STHeitiMedium.ttc';
      this.applyFontSelection();
    };
    api('GET', '/fonts').then(res => {
      const fonts = (res && res.fonts) || [];
      const def = (res && res.default) || this._defaultFont || 'STHeitiMedium.ttc';
      if (fonts.length) { build(fonts, def); return; }
      build(FALLBACK_FONTS, FALLBACK_DEFAULT);
    }).catch(() => {
      build(FALLBACK_FONTS, FALLBACK_DEFAULT);
    });
  },
  applyFontSelection() {
    const sel = document.getElementById('font_name');
    if (!sel) return;
    const want = this._savedFontName || this._defaultFont || 'STHeitiMedium.ttc';
    const has = v => [...sel.options].some(o => o.value === v);
    if (has(want)) sel.value = want;
    else if (has(this._defaultFont)) sel.value = this._defaultFont;
  },
  loadLocalAssets() {
    const box = document.getElementById('localAssetList');
    if (!box) return;
    box.innerHTML = '<span class="muted">加载中…</span>';
    api('GET', '/agent/assets?type=video').then(list => {
      if (!list || !list.length) {
        box.innerHTML = '<span class="muted">暂无视频资产，请先到「资产管理」上传视频。</span>';
        return;
      }
      this._localAssetMap = {};
      box.innerHTML = list.map(a => {
        const exists = a.exists !== false;
        const url = a.path.replace(/^storage\/assets\/files\//, '');
        this._localAssetMap[a.id] = { url, name: a.name, exists };
        const sel = this._localAssetSel.has(a.id);
        const disabled = exists ? '' : 'disabled title="文件已被删除，无法选用"';
        const checked = (sel && exists) ? 'checked' : '';
        const cls = (sel && exists) ? 'localAssetItem selected' : 'localAssetItem';
        let preview;
        if (!exists) {
          // 孤儿记录：文件已从磁盘删除但元数据残留，避免发 404 预览请求造成黑屏
          preview = '<span class="localAssetMissing">⚠ 文件缺失</span>';
        } else {
          const pv = assetUrl(a.path);
          preview = pv
            ? `<video class="localAssetVid" preload="metadata" muted playsinline controls src="${esc(pv)}"></video>`
            : '<span class="muted">无预览</span>';
        }
        return `<div class="${cls}" data-id="${esc(a.id)}">
          <input type="checkbox" class="localAssetCb" value="${esc(a.id)}" ${checked} ${disabled}/>
          <span class="localAssetPrev">${preview}</span>
          <span class="localAssetName" title="${esc(a.name)}">${esc(a.name)}</span>
        </div>`;
      }).join('');
      box.querySelectorAll('.localAssetItem').forEach(item => {
        const cb = item.querySelector('.localAssetCb');
        cb.onchange = () => {
          if (cb.checked) { this._localAssetSel.add(cb.value); item.classList.add('selected'); }
          else { this._localAssetSel.delete(cb.value); item.classList.remove('selected'); }
        };
        // 点击卡片（视频播放控件 / 复选框 除外）切换选中
        item.onclick = (e) => {
          if (e.target.closest('.localAssetVid') || e.target.closest('.localAssetCb')) return;
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event('change'));
        };
        // 视频点击：交给原生控件播放，不触发卡片选中
        const vid = item.querySelector('.localAssetVid');
        if (vid) {
          vid.addEventListener('click', (e) => e.stopPropagation());
          vid.addEventListener('loadedmetadata', () => {
            // 强制定位到首帧，避免黑屏（preload=metadata 不保证显示画面）
            try { vid.currentTime = Math.min(0.1, vid.duration || 0.1); } catch (err) {}
          });
          // 加载失败（编码异常/首帧缺失）优雅降级，避免黑框
          vid.addEventListener('error', () => {
            const prev = vid.closest('.localAssetPrev');
            if (prev) prev.innerHTML = '<span class="localAssetMissing">预览不可用</span>';
          });
        }
      });
    }).catch(e => { box.innerHTML = '<span class="muted">加载失败：' + esc(e.message) + '</span>'; });
  },
  resetSubtitle() {
    document.getElementById('subtitle_enabled').checked = true;
    document.getElementById('subtitle_position').value = 'bottom';
    document.getElementById('customPosWrap').style.display = 'none';
    document.getElementById('custom_position').value = 70;
    document.getElementById('font_size').value = 60;
    document.getElementById('font_name').value = 'STHeitiMedium.ttc';
    document.getElementById('text_fore_color').value = '#FFFFFF';
    document.getElementById('stroke_color').value = '#000000';
    document.getElementById('stroke_width').value = 1.5;
    document.getElementById('text_background_color').checked = false;
    document.getElementById('rounded_subtitle_background').checked = false;
    toast('字幕设置已恢复默认');
  },
  // 渲染一条可视进度条（复用 .rprog/.rprog-bar 样式）。
  // prog 为数字百分比；indeterminate=true 时表示后端尚未上报进度，
  // 显示一段循环流动的光带动画，提示「正在工作」而非卡死。
  _renderProgress(prog, indeterminate, note) {
    const pct = indeterminate ? '' : (Math.max(0, Math.min(100, prog)) + '%');
    const barCls = 'rprog-bar' + (indeterminate ? ' indet' : '');
    const barStyle = indeterminate ? 'width:100%' : `width:${pct}`;
    return `
      <div class="rprog" style="margin-top:10px"><div class="${barCls}" style="${barStyle}"></div></div>
      <div class="rprog-pct">${indeterminate ? '生成中…' : pct}</div>
      ${note ? `<div class="muted" style="margin-top:4px">${note}</div>` : ''}`;
  },
  poll(taskId) {
    const box = document.getElementById('genProgress');
    box.classList.remove('hidden');
    const tick = async () => {
      try {
        const t = await api('GET', '/tasks/' + taskId);
        const indeterminate = (t.progress == null || t.progress === '');
        const prog = indeterminate ? 0 : Number(t.progress) || 0;
        const head = `<div style="display:flex;justify-content:space-between;align-items:center">
          <strong>任务 ${taskId.slice(0, 8)}</strong> ${stateTag(t.state)}</div>`;
        if (t.state == 1 && (t.videos || t.combined_videos || t.cover_path)) {
          this._renderCompletedTask(t);
          return;
        }
        if (t.state == -1) {
          const html = head + `<div class="tag bad" style="margin-top:8px">生成失败：${esc(t.error || t.last_error || '未知错误')}</div>`;
          box.innerHTML = html; return;
        }
        box.innerHTML = head + this._renderProgress(prog, indeterminate, '生成中，请稍候…');
        setTimeout(tick, 1500);
      } catch (e) {
        box.innerHTML = `<div class="tag bad">查询失败：${esc(e.message)}</div>`;
      }
    };
    tick();
  },
  // 把一条已完成（含成片）的任务渲染进 #genProgress 大播放器卡片。
  // 生成轮询完成时用，页面刷新后恢复最近一次成片时也复用，避免刷新即丢失视图。
  _renderCompletedTask(t) {
    const box = document.getElementById('genProgress');
    box.classList.remove('hidden');
    let html = `<div style="display:flex;justify-content:space-between;align-items:center">
      <strong>任务 ${t.task_id.slice(0, 8)}</strong> ${stateTag(t.state)}</div>`;
    if (t.title) html += `<div class="muted" style="margin:8px 0">标题：<b style="color:var(--text)">${esc(t.title)}</b></div>`;
    const tline = [t.start_time && ('开始：' + esc(t.start_time)), t.end_time && ('完成：' + esc(t.end_time))].filter(Boolean).join('　');
    if (tline) html += `<div class="muted" style="margin:4px 0;font-size:12px">${tline}</div>`;
    const vids = (t.videos || []).concat(t.combined_videos || []);
    if (vids.length) html += '<div class="video-wrap pill-row">' + vids.map(v =>
      `<div><video src="${esc(v)}" controls></video><br><a class="btn sm" href="${esc(v)}" download>下载</a></div>`).join('') + '</div>';
    const cover = assetUrl(t.cover_path);
    if (cover) html += `<div style="margin-top:10px"><div class="muted" style="margin-bottom:6px">封面（点击放大）</div><img class="cover-thumb" src="${esc(cover)}" alt="封面"/></div>`;
    box.innerHTML = html;
    const ct = box.querySelector('.cover-thumb');
    if (ct) ct.onclick = () => openLightbox(ct.src, '封面预览');
  },
  // 刷新/切回生成页时，若最近有已完成的成片任务，重新渲染进 #genProgress，
  // 让刷新后的视图与生成完成时一致。列表数据若已带 videos 直接用，否则回查详情。
  async _restoreLatestVideo() {
    const latest = (this._tasks || [])
      .filter(t => t.state === 1)
      .sort((a, b) => String(b.updated_at || b.task_id).localeCompare(String(a.updated_at || a.task_id)))[0];
    if (!latest) return;
    let t = latest;
    if (!((latest.videos || []).concat(latest.combined_videos || [])).length) {
      try { t = await api('GET', '/tasks/' + latest.task_id); }
      catch (e) { return; }
    }
    if (t && ((t.videos || []).concat(t.combined_videos || [])).length) {
      this._renderCompletedTask(t);
    }
  },
  async loadTasks() {
    const box = document.getElementById('taskList');
    try {
      const d = await api('GET', '/tasks?page=1&page_size=12');
      // 生成页只展示混剪任务，口播任务统一在「历史任务」与「调度看板」中管理，
      // 避免同一口播任务在多处重复出现。
      const tasks = ((d && d.tasks) || []).filter(t => taskKind(t) !== 'agent');
      this._tasks = tasks;
      if (!tasks.length) { box.innerHTML = '<p class="muted">暂无任务</p>'; return; }
      box.innerHTML = `<table><thead><tr><th>任务</th><th>状态</th><th>进度</th><th>开始时间</th><th>完成时间</th><th>成片</th><th></th></tr></thead><tbody>` +
        tasks.map(t => {
          const vids = (t.videos || []).concat(t.combined_videos || []);
          return `<tr>
            <td>${esc((t.params && t.params.video_subject) || t.task_id.slice(0, 8))}</td>
            <td>${stateTag(t.state)}</td>
            <td>${t.progress != null ? t.progress + '%' : ''}</td>
            <td style="font-size:12px;white-space:nowrap">${t.start_time ? esc(t.start_time) : '<span class="muted">—</span>'}</td>
            <td style="font-size:12px;white-space:nowrap">${t.end_time ? esc(t.end_time) : '<span class="muted">—</span>'}</td>
            <td>${videoGallery(vids, true)}</td>
            <td>${(t.state===4||t.state===0)?`<button class="btn sm" data-cancel="${t.task_id}">取消</button> `:''}${(t.state==-1||t.state==6)?`<button class="btn sm" data-resubmit="${t.task_id}">重新生成</button> `:''}<button class="btn sm ghost" data-del="${t.task_id}">删除</button></td>
          </tr>`;
        }).join('') + '</tbody></table>';
      box.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (!confirm('确认删除该任务？')) return;
        try { await api('DELETE', '/tasks/' + b.dataset.del); toast('已删除'); this.loadTasks(); }
        catch (e) { toast(e.message, true); }
      });
      box.querySelectorAll('[data-resubmit]').forEach(b => b.onclick = () => {
        const t = (this._tasks || []).find(x => x.task_id === b.dataset.resubmit);
        if (t) this.resubmit(t);
      });
      box.querySelectorAll('[data-cancel]').forEach(b => b.onclick = async () => {
        try { await api('POST', '/tasks/' + b.dataset.cancel + '/cancel'); toast('已发送取消，任务将停止'); this.loadTasks(); }
        catch (e) { toast(e.message, true); }
      });
    } catch (e) { box.innerHTML = '<p class="muted">加载失败：' + esc(e.message) + '</p>'; }
  },
  async resubmit(task) {
    const p = task.params || {};
    const keys = ['video_subject','video_script','video_terms','video_aspect','video_count','video_source','voice_name','voice_mode','tts_server','custom_audio_file','bgm_type','video_language','subtitle_enabled','subtitle_position','custom_position','font_name','font_size','text_fore_color','stroke_color','stroke_width','text_background_color','rounded_subtitle_background','voice_volume','voice_rate','bgm_volume','video_music_prompt','bgm_file','video_concat_mode','video_transition_mode','video_clip_duration','video_clip_speed','agent_mode','persona_id','reference_source','transcript_text'];
    const body = {};
    keys.forEach(k => { const v = p[k]; if (v !== undefined && v !== null && v !== '') body[k] = v; });
    if (!body.video_subject) { toast('该任务缺少主题，无法重提', true); return; }
    try {
      const data = await api('POST', '/videos', body);
      toast('已重新提交生成');
      this.poll(data.task_id);
      this.loadTasks();
    } catch (e) { toast(e.message, true); }
  },
};

/* ===== 人物管理（数字人形象） ===== */
VIEWS.chars = {
  html() {
    return `
      <h1>人物管理</h1>
      <p class="sub">管理数字人形象的「人物」：名称、口吻与数字人源图/源视频，后续生成任务可一键套用。</p>
      <div style="margin-bottom:14px"><button class="btn" id="newChar">+ 新建人物</button></div>
      <div id="charList" class="card"></div>
      <div id="dhPanel" class="card hidden" style="margin-top:16px"></div>`;
  },
  init() {
    document.getElementById('newChar').onclick = () => this.edit(null);
    this.load();
  },
  async load() {
    const box = document.getElementById('charList');
    try {
      const list = await api('GET', '/agent/personas');
      if (!list.length) { box.innerHTML = '<p class="muted">暂无人物，点击「新建人物」。</p>'; return; }
      const base = s => (s || '').split('/').pop() || '-';
      box.innerHTML = '<table><thead><tr><th>名称</th><th>口吻</th><th>数字人 Provider</th><th>源图</th><th>源视频</th><th></th></tr></thead><tbody>' +
        list.map(p => {
          const dh = p.digital_human || {};
          return `<tr>
            <td>${esc(p.name || p.id)}</td>
            <td class="muted">${esc((p.tone || '').slice(0, 20))}</td>
            <td>${esc(dh.provider || '-')}</td>
            <td class="muted">${esc(base(dh.source_image))}</td>
            <td class="muted">${esc(base(dh.source_video))}</td>
            <td><button class="btn sm" data-edit="${p.id}">编辑</button>
                <button class="btn sm" data-dh="${p.id}">数字人</button>
                <button class="btn sm danger" data-del="${p.id}">删除</button></td>
          </tr>`;
        }).join('') + '</tbody></table>';
      box.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => this.edit(b.dataset.edit));
      box.querySelectorAll('[data-dh]').forEach(b => b.onclick = () => this.editDigitalHuman(b.dataset.dh));
      box.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (!confirm('确认删除该人物？')) return;
        try { await api('DELETE', '/agent/personas/' + b.dataset.del); toast('已删除'); this.load(); }
        catch (e) { toast(e.message, true); }
      });
    } catch (e) { box.innerHTML = '<p class="muted">加载失败：' + esc(e.message) + '</p>'; }
  },
  TONE_PRESETS: [
    { k: '亲切邻家', v: '像朋友一样自然聊天，拉近距离；多用口语和"你/咱们"，少说教。' },
    { k: '专业权威', v: '行业专家口吻，逻辑严谨、数据说话，用词准确克制，适当引用术语但不卖弄。' },
    { k: '幽默搞怪', v: '段子化表达，金句频出、节奏轻快，善用夸张与反差制造笑点，解压感强。' },
    { k: '激情热血', v: '情绪饱满、鼓动性强，短句有力、语调上扬，适合励志与促单场景。' },
    { k: '沉稳冷静', v: '娓娓道来、克制理性，语速平稳，偏重分析与判断，不煽情。' },
    { k: '犀利点评', v: '观点鲜明、直接敢说，善于拆解与反驳，语气带锋芒，适合评论吐槽。' },
    { k: '温暖治愈', v: '柔软共情、语气温柔，先接住情绪再给建议，适合情感与陪伴内容。' },
    { k: '知性优雅', v: '文艺温润、有审美，词汇讲究、留白得当，适合生活方式与品牌调性。' },
    { k: '接地气市井', v: '方言或强口语感，烟火气足，像街坊唠嗑，真实不做作。' },
    { k: '干脆利落', v: '以短句为主、节奏快、不绕弯，结论先行，适合干货与资讯。' },
  ],
  STYLE_PRESETS: [
    { k: '短视频爆款', v: '短视频爆款', d: '节奏快、钩子前置、强情绪，前 3 秒抓人。' },
    { k: '知识科普', v: '知识科普', d: '把一个知识点讲通俗有趣，有类比有记忆点。' },
    { k: '种草带货', v: '种草带货', d: '突出卖点与使用场景，制造向往并促单。' },
    { k: '情感故事', v: '情感故事', d: '叙事驱动，有起承转合与情绪起伏。' },
    { k: '新闻资讯', v: '新闻资讯', d: '客观及时，信息密度高，要点清晰。' },
    { k: '产品评测', v: '产品评测', d: '对比实测、给出明确结论与适用人群。' },
    { k: 'Vlog日常', v: 'Vlog日常', d: '第一人称生活化记录，松弛有陪伴感。' },
    { k: '剧情演绎', v: '剧情演绎', d: '人设出镜小剧场，靠情节与冲突吸引。' },
    { k: '口播干货', v: '口播干货', d: '步骤化、可操作，看完就能用上。' },
    { k: '品牌宣传', v: '品牌宣传', d: '调性统一，传递价值主张与品牌记忆点。' },
  ],
  async edit(id) {
    const TONE_PRESETS = this.TONE_PRESETS;
    const STYLE_PRESETS = this.STYLE_PRESETS;
    let p = { name: '', tone: '', style_preset: '', avatar_image: '', digital_human: { provider: 'auto', source_image: '', source_video: '' }, voice: { provider: 'none' } };
    if (id) { try { p = await api('GET', '/agent/personas/' + id); } catch (e) { toast(e.message, true); return; } }
    const dh = p.digital_human || {};
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `<div class="card modal">
      <h2 style="margin-top:0">${id ? '编辑人物' : '新建人物'}</h2>
      <div class="field"><label>名称 *</label><input id="f_name" value="${esc(p.name)}"/></div>
      <div class="field"><label>口吻描述</label>
        <select id="f_tone_preset" class="preset-sel">
          <option value="">— 选择常用口吻，或下方自定义 —</option>
          ${TONE_PRESETS.map(t => `<option value="${esc(t.v)}" title="${esc(t.v)}" ${t.v === (p.tone || '') ? 'selected' : ''}>${esc(t.k)}</option>`).join('')}
        </select>
        <textarea id="f_tone" placeholder="描述这个人说话的语气、节奏、用词习惯…">${esc(p.tone || '')}</textarea>
      </div>
      <div class="field"><label>风格预设</label>
        <select id="f_style_preset" class="preset-sel">
          <option value="">— 选择常用风格，或下方自定义 —</option>
          ${STYLE_PRESETS.map(s => `<option value="${esc(s.v)}" title="${esc(s.d)}" ${s.v === (p.style_preset || '') ? 'selected' : ''}>${esc(s.k)}</option>`).join('')}
        </select>
        <input id="f_style" placeholder="如：知识科普 / 种草带货" value="${esc(p.style_preset || '')}"/>
      </div>
      <div class="field"><label>头像图路径（可选）</label><input id="f_avatar" value="${esc(p.avatar_image || '')}"/></div>
      <p class="muted" style="margin:4px 0 0">数字人形象请在下方「数字人形象」区块配置（点列表行「数字人」）。</p>
      <div style="margin-top:14px;display:flex;gap:10px;justify-content:flex-end">
        <button class="btn ghost" id="cancel">取消</button>
        <button class="btn" id="save">保存</button>
      </div>
    </div>`;
    document.body.appendChild(mask);
    mask.querySelector('#cancel').onclick = () => mask.remove();
    mask.querySelector('#f_tone_preset').onchange = e => { if (e.target.value) mask.querySelector('#f_tone').value = e.target.value; };
    mask.querySelector('#f_style_preset').onchange = e => { if (e.target.value) mask.querySelector('#f_style').value = e.target.value; };
    mask.querySelector('#save').onclick = async () => {
      const body = {
        name: mask.querySelector('#f_name').value.trim(),
        tone: mask.querySelector('#f_tone').value,
        style_preset: mask.querySelector('#f_style').value,
        avatar_image: mask.querySelector('#f_avatar').value,
      };
      if (!body.name) { toast('请填写名称', true); return; }
      try {
        if (id) { await api('PUT', '/agent/personas/' + id, body); toast('已更新'); }
        else { await api('POST', '/agent/personas', body); toast('已创建'); }
        mask.remove(); this.load();
      } catch (e) { toast(e.message, true); }
    };
  },
  async editDigitalHuman(id) {
    let p = { name: '', digital_human: { provider: 'auto', source_image: '', source_video: '' } };
    if (id) { try { p = await api('GET', '/agent/personas/' + id); } catch (e) { toast(e.message, true); return; } }
    const dh = p.digital_human || {};
    const panel = document.getElementById('dhPanel');
    panel.classList.remove('hidden');
    panel.innerHTML = `<h2 style="margin-top:0">配置数字人形象：${esc(p.name || p.id)}</h2>
      <p class="sub">配置该人物的数字人 Provider、源图与源视频；保存仅更新数字人部分，不影响名称/音色等其它字段。</p>
      <div class="row">
        <div class="field"><label>Provider</label><select id="dh_provider">
          ${['auto', 'cloud_hegen', 'cloud_did', 'cloud_siliconflow', 'local_sadtalker', 'local_heygem'].map(o => `<option ${dh.provider === o ? 'selected' : ''}>${o}</option>`).join('')}
        </select></div>
        <div class="field"><label>源图片路径</label><input id="dh_img" value="${esc(dh.source_image || '')}"/><input type="file" id="dh_img_file" style="margin-top:6px"></div>
        <div class="field"><label>源视频路径</label><input id="dh_vid" value="${esc(dh.source_video || '')}"/><input type="file" id="dh_vid_file" style="margin-top:6px"></div>
      </div>
      <div style="margin-top:14px;display:flex;gap:10px;justify-content:flex-end">
        <button class="btn ghost" id="dh_cancel">收起</button>
        <button class="btn" id="dh_save">保存数字人</button>
      </div>`;
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    panel.querySelector('#dh_cancel').onclick = () => panel.classList.add('hidden');
    const upload = async (fi, pi) => {
      if (!fi.files.length) return;
      const fd = new FormData(); fd.append('file', fi.files[0]); fd.append('category', 'digital_human');
      const r = await fetch(API + '/upload', { method: 'POST', body: fd });
      const j = await r.json();
      if (j.status === 200) pi.value = j.data.path; else toast(j.message || '上传失败', true);
    };
    panel.querySelector('#dh_save').onclick = async () => {
      if (fileInput_hasFiles(panel, '#dh_img_file')) await upload(panel.querySelector('#dh_img_file'), panel.querySelector('#dh_img'));
      if (fileInput_hasFiles(panel, '#dh_vid_file')) await upload(panel.querySelector('#dh_vid_file'), panel.querySelector('#dh_vid'));
      const body = {
        digital_human: { provider: panel.querySelector('#dh_provider').value, source_image: panel.querySelector('#dh_img').value, source_video: panel.querySelector('#dh_vid').value },
      };
      try { await api('PUT', '/agent/personas/' + id, body); toast('数字人形象已保存'); panel.classList.add('hidden'); this.load(); }
      catch (e) { toast(e.message, true); }
    };
  },
};

/* ===== 声音克隆 & 音频设置 ===== */
VIEWS.voices = {
  html() {
    return `
      <h1>声音克隆</h1>
      <p class="sub">配置配音方式、选择 TTS 服务与音色、克隆专属声音，支持试听与完整预览。</p>

      <!-- 音频设置面板 -->
      <div class="card" style="margin-top:12px">
        <h3 style="margin-top:0">音频设置</h3>

        <!-- 配音方式：自动配音 / 上传音频 / 无配音 -->
        <div class="field"><label>配音方式</label>
          <div class="seg" id="v_modeSeg" style="margin-bottom:14px">
            <button data-mode="tts" class="active">自动配音</button>
            <button data-mode="upload">上传音频</button>
            <button data-mode="none">无配音</button>
          </div>
        </div>

        <!-- TTS 模式下的设置 -->
        <div id="v_ttsPanel">
          <div class="field">
            <label>配音服务</label>
            <select id="v_service"><option value="">加载中…</option></select>
          </div>
          <div class="field">
            <label>配音声音（与文案语言保持一致）</label>
            <select id="v_voice"><option value="">请先选择服务</option></select>
          </div>
          <div class="row">
            <div class="field"><label>配音音量 <span class="muted" style="font-weight:400">ⓘ</span></label>
              <select id="v_volume">${[0.5,0.75,1.0,1.25,1.5,2.0].map(v=>`<option value="${v}"${v===1.0?' selected':''}>${Math.round(v*100)}%</option>`).join('')}</select>
            </div>
            <div class="field"><label>配音语速 <span class="muted" style="font-weight:400">ⓘ</span></label>
              <select id="v_rate">${[0.5,0.75,0.9,1.0,1.1,1.25,1.5,2.0].map(v=>`<option value="${v}"${v===1.0?' selected':''}>${v.toFixed(1).replace('.0','')}× </option>`).join('')}</select>
            </div>
          </div>
          <p class="muted" style="margin:8px 0 10px;font-size:12px">填写视频文案后，可估算并预览完整配音。</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn" id="v_previewVoice">🎧 试听音色</button>
            <button class="btn ghost" id="v_previewFull">🔊 完整试听</button>
          </div>
          <!-- 试听播放器 -->
          <audio id="v_audioPlayer" controls style="display:none;width:100%;margin-top:10px;border-radius:8px"></audio>
        </div>

        <!-- 上传音频模式 -->
        <div id="v_uploadPanel" class="hidden">
          <div class="field"><label>上传音频文件</label>
            <input type="file" id="v_audioFile" accept="audio/*"/>
            <p class="muted" id="v_uploadHint" style="margin:6px 0 0">选择 mp3/wav 等音频文件作为口播配音</p>
          </div>
        </div>
      </div>

      <!-- 声音克隆面板 -->
      <div class="card" style="margin-top:16px">
        <h3 style="margin-top:0">声音克隆</h3>
        <p class="muted" style="font-size:12px;margin-bottom:12px">上传一段 10~30 秒的清晰人声样本，即可克隆该说话人的音色。支持本地 XTTS 与远程云端模型。</p>

        <div class="row">
          <div class="field"><label>克隆 Provider</label><select id="vc_provider">
            <option value="local_xtts">本地 XTTS（需本地模型）</option>
            <option value="local_cosyvoice">本地 CosyVoice（需本地模型）</option>
            <option value="cloud_cosyvoice">阿里 CosyVoice（云端·待接入）</option>
            <option value="cloud_minimax">MiniMax 克隆（云端）</option>
            <option value="cloud_elevenlabs">ElevenLabs 克隆（云端）</option>
          </select></div>
          <div class="field"><label>样本音频</label>
            <input type="file" id="vc_sampleFile" accept="audio/*"/>
            <p class="muted" id="vc_sampleHint" style="margin:4px 0 0">选择 10~30 秒清晰人声（推荐无背景音乐）</p>
          </div>
        </div>
        <div style="margin-top:10px;display:flex;gap:10px;align-items:center">
          <button class="btn" id="vc_cloneBtn">开始克隆</button>
          <span id="vc_result" class="muted" style="font-size:12px"></span>
        </div>
        <!-- 克隆进度 -->
        <div id="vc_progWrap" class="hidden" style="margin-top:10px">
          <div class="rprog-stage" id="vcProgStage">准备中…</div>
          <div class="rprog"><div class="rprog-bar" id="vcProgBar" style="width:6%"></div></div>
          <div class="rprog-pct" id="vcProgPct">6%</div>
        </div>
      </div>`;
  },
  init() {
    // --- 配音方式切换 ---
    const seg = document.getElementById('v_modeSeg');
    const ttsPanel = document.getElementById('v_ttsPanel');
    const upPanel = document.getElementById('v_uploadPanel');
    seg.querySelectorAll('button').forEach(b => b.onclick = () => {
      seg.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const m = b.dataset.mode;
      ttsPanel.classList.toggle('hidden', m !== 'tts');
      upPanel.classList.toggle('hidden', m !== 'upload');
    });

    // --- 加载 TTS 服务列表 ---
    this._loadServices();

    // --- 试听音色 ---
    document.getElementById('v_previewVoice').onclick = async () => {
      const voice = document.getElementById('v_voice').value;
      if (!voice) { toast('请先选择配音声音', true); return; }
      await this._previewAudio('你好，这是一段试听音频，用于测试当前音色的效果。');
    };

    // --- 完整试听 ---
    document.getElementById('v_previewFull').onclick = async () => {
      const voice = document.getElementById('v_voice').value;
      if (!voice) { toast('请先选择配音声音', true); return; }
      const text = prompt('输入要试听的文案（留空使用默认）：', '随遇而安不也是一种生活？在城市的夜晚独自散步，你会发现安静不是孤独，而是一种难得的自由。');
      if (text === null) return;
      await this._previewAudio(text || '你好，这是完整试听。');
    };

    // --- 上传音频模式 ---
    let uploadedAudioPath = null;
    document.getElementById('v_audioFile').onchange = async () => {
      const inp = document.getElementById('v_audioFile');
      const hint = document.getElementById('v_uploadHint');
      if (!inp.files.length) { uploadedAudioPath = null; return; }
      hint.textContent = '上传中…';
      const fd = new FormData(); fd.append('file', inp.files[0]); fd.append('category', 'misc');
      try {
        const r = await fetch(API + '/upload', { method: 'POST', body: fd });
        const j = await r.json();
        if (j && j.status === 200) { uploadedAudioPath = j.data.path; hint.textContent = '已上传：' + j.data.file; }
        else { uploadedAudioPath = null; hint.textContent = '上传失败'; }
      } catch (e) { uploadedAudioPath = null; hint.textContent = '上传失败: ' + e.message; }
    };

    // --- 声音克隆：样本上传 ---
    let samplePath = null;
    document.getElementById('vc_sampleFile').onchange = async () => {
      const inp = document.getElementById('vc_sampleFile');
      const hint = document.getElementById('vc_sampleHint');
      if (!inp.files.length) { samplePath = null; return; }
      hint.textContent = '上传中…';
      const fd = new FormData(); fd.append('file', inp.files[0]); fd.append('category', 'voice');
      try {
        const r = await fetch(API + '/upload', { method: 'POST', body: fd });
        const j = await r.json();
        if (j && j.status === 200) { samplePath = j.data.path; hint.textContent = '已上传：' + j.data.file + '（点击「开始克隆」）'; }
        else { samplePath = null; hint.textContent = '上传失败'; }
      } catch (e) { samplePath = null; hint.textContent = '上传失败: ' + e.message; }
    };

    // --- 开始克隆（SSE 流式）---
    document.getElementById('vc_cloneBtn').onclick = async () => {
      if (!samplePath) { toast('请先上传样本音频', true); return; }
      const btn = document.getElementById('vc_cloneBtn');
      const resultEl = document.getElementById('vc_result');
      const progWrap = document.getElementById('vc_progWrap');
      btn.disabled = true; btn.classList.add('disabled');
      resultEl.textContent = '';
      progWrap.classList.remove('hidden');
      const setProg = (pct, msg) => {
        const bar = document.getElementById('vcProgBar');
        const stage = document.getElementById('vcProgStage');
        const pctEl = document.getElementById('vcProgPct');
        if (bar) bar.style.width = Math.max(6, Math.min(100, pct)) + '%';
        if (stage && msg) stage.textContent = msg;
        if (pctEl) pctEl.textContent = Math.max(6, Math.min(100, pct)) + '%';
      };
      try {
        const res = await fetch(API + '/agent/voice/clone', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: document.getElementById('vc_provider').value,
            sample_audio: samplePath,
          }),
        });
        if (!res.ok || !res.body) throw new Error('请求失败 ' + res.status);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const dl = chunk.split('\n').find(l => l.startsWith('data: '));
            if (!dl) continue;
            let evt;
            try { evt = JSON.parse(dl.slice(6)); } catch { continue; }
            if (evt.type === 'progress') setProg(evt.pct, evt.msg);
            else if (evt.type === 'done') {
              setProg(100, '克隆完成 ✓');
              const d = evt.data;
              resultEl.innerHTML = '<span class="tag ok">克隆成功</span> voice_id: <code>' + esc(d.voice_id) + '</code> (' + d.provider + ')';
              progWrap.classList.add('hidden');
            } else if (evt.type === 'error') {
              setProg(100, '失败'); resultEl.innerHTML = '<span class="tag bad">' + esc(evt.message) + '</span>';
            }
          }
        }
      } catch (e) {
        setProg(100, '失败'); resultEl.innerHTML = '<span class="tag bad">' + esc(e.message) + '</span>';
      } finally { btn.disabled = false; btn.classList.remove('disabled'); }
    };
  },

  /* ---- 内部方法 ---- */
  async _loadServices() {
    try {
      const data = await api('GET', '/agent/tts/services');
      const sel = document.getElementById('v_service');
      const vSel = document.getElementById('v_voice');
      const svcs = data.services || [];
      if (!svcs.length) { sel.innerHTML = '<option value="">无可用 TTS 服务（请在 config.toml 配置 API Key）</option>'; return; }

      sel.innerHTML = svcs.map(s =>
        `<option value="${esc(s.id)}"${s.id === data.current_service ? ' selected' : ''}${s.planned ? ' disabled' : ''}>${esc(s.label)}${s.channel === 'local' ? '（本地）' : ''}${s.planned ? '（待接入）' : ''}${s.error ? ' (' + esc(s.error) + ')' : ''}</option>`
      ).join('');

      // 切换服务 → 更新声音列表
      const populateVoices = () => {
        const sid = sel.value;
        const svc = svcs.find(s => s.id === sid);
        const voices = (svc && svc.voices) || [];
        vSel.innerHTML = voices.length
          ? voices.map(v => `<option value="${esc(v)}"${v === data.current_voice ? ' selected' : ''}>${esc(v)}</option>`).join('')
          : '<option value="">该服务无可用音色</option>';
      };
      sel.onchange = populateVoices;
      populateVoices(); // 初始填充
    } catch (e) {
      document.getElementById('v_service').innerHTML = '<option value="">加载失败</option>';
    }
  },

  async _previewAudio(text) {
    const player = document.getElementById('v_audioPlayer');
    const pBtn = document.getElementById('v_previewVoice');
    const fBtn = document.getElementById('v_previewFull');
    pBtn.disabled = true; fBtn.disabled = true;
    pBtn.classList.add('disabled'); fBtn.classList.add('disabled');
    try {
      player.style.display = 'block'; player.src = ''; player.load();
      const d = await api('POST', '/agent/tts/preview', {
        service: document.getElementById('v_service').value,
        voice_name: document.getElementById('v_voice').value,
        text: text,
        volume: parseFloat(document.getElementById('v_volume').value),
        rate: parseFloat(document.getElementById('v_rate').value),
      });
      if (d.audio_url) {
        player.src = d.audio_url;
        player.play().catch(() => {}); // 自动播放可能被浏览器拦截
        if (d.duration) player.title = '时长: ' + d.duration + 's';
      }
    } catch (e) {
      toast('试听失败: ' + e.message, true);
      player.style.display = 'none';
    } finally {
      pBtn.disabled = false; fBtn.disabled = false;
      pBtn.classList.remove('disabled'); fBtn.classList.remove('disabled');
    }
  },
};

/* ===== 数字人生（独立页面） ===== */
VIEWS.dh = {
  html() {
    return `
      <h1>数字人生</h1>
      <p class="sub">单独生成一段数字人口播视频：选人设（或上传肖像）→ 写口播文案 → 选配音音色 → 生成。后端先用 TTS 合成配音，再用本地 SadTalker 对口型。</p>

      <div class="card" style="margin-bottom:16px">
        <h3 style="margin-top:0">① 数字人形象</h3>
        <div class="field">
          <label>复用人物（可选）</label>
          <select id="dh_persona"><option value="">不使用人设，下方手动上传肖像</option></select>
          <p class="muted" style="margin:6px 0 0">选择后自动带入该人物的数字人 Provider 与肖像图；其「数字人 Provider」须设为 local_sadtalker 等具体引擎，auto 不生效。</p>
        </div>
        <div class="row">
          <div class="field" style="flex:1">
            <label>Provider</label>
            <select id="dh_provider">
              <option value="local_sadtalker">local_sadtalker（SadTalker 本地）</option>
              <option value="local_heygem">local_heygem（HeyGem 本地）</option>
              <option value="cloud_hegen">cloud_hegen（HeyGen 云端）</option>
              <option value="cloud_did">cloud_did（D-ID 云端）</option>
              <option value="cloud_siliconflow">cloud_siliconflow（硅基流动）</option>
            </select>
          </div>
          <div class="field" style="flex:2">
            <label>肖像图路径（图片驱动必填）</label>
            <input id="dh_image" placeholder="上传或粘贴肖像图绝对路径" />
            <input type="file" id="dh_image_file" accept="image/*" style="margin-top:6px" />
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <h3 style="margin-top:0">② 口播文案与配音</h3>
        <div class="field">
          <label>口播文案 *</label>
          <textarea id="dh_text" placeholder="输入要数字人念出来的口播文案"></textarea>
        </div>
        <div class="row">
          <div class="field" style="flex:1">
            <label>配音服务</label>
            <select id="dh_service"><option value="">加载中…</option></select>
          </div>
          <div class="field" style="flex:1">
            <label>配音音色</label>
            <select id="dh_voice"><option value="">请先选择服务</option></select>
          </div>
        </div>
        <div class="row">
          <div class="field" style="flex:1"><label>配音音量(0–2)</label><input id="dh_volume" type="number" value="1.0" step="0.1" min="0" max="2" /></div>
          <div class="field" style="flex:1"><label>配音语速(0.5–2)</label><input id="dh_rate" type="number" value="1.0" step="0.1" min="0.5" max="2" /></div>
        </div>
      </div>

      <button class="btn" id="dh_generate">生成数字人视频</button>

      <div id="dh_prog" class="rprog-wrap hidden" style="margin-top:14px">
        <div class="rprog-stage" id="dh_progStage">准备中…</div>
        <div class="rprog"><div class="rprog-bar" id="dh_progBar" style="width:0%"></div></div>
        <div class="rprog-pct" id="dh_progPct">0%</div>
      </div>

      <div id="dh_result" class="card hidden" style="margin-top:16px">
        <h3 style="margin-top:0">生成结果</h3>
        <video id="dh_video" controls style="width:100%;max-width:480px;border-radius:8px"></video>
      </div>`;
  },
  init() {
    // 加载人物列表
    api('GET', '/agent/personas').then(list => {
      const sel = document.getElementById('dh_persona');
      (list || []).forEach(p => {
        const o = document.createElement('option');
        o.value = p.id; o.textContent = p.name + (p.digital_human && p.digital_human.provider && p.digital_human.provider !== 'auto' ? '（已配数字人）' : '');
        sel.appendChild(o);
      });
    }).catch(() => {});
    document.getElementById('dh_persona').onchange = async (e) => {
      const pid = e.target.value;
      if (!pid) return;
      try {
        const p = await api('GET', '/agent/personas/' + pid);
        const dh = p.digital_human || {};
        if (dh.provider && dh.provider !== 'auto') document.getElementById('dh_provider').value = dh.provider;
        if (dh.source_image) document.getElementById('dh_image').value = dh.source_image;
      } catch (err) { toast(err.message, true); }
    };

    // 加载 TTS 服务与音色
    this._loadTtsServices();

    // 肖像上传
    document.getElementById('dh_image_file').onchange = async (e) => {
      if (!e.target.files.length) return;
      const fd = new FormData();
      fd.append('file', e.target.files[0]);
      fd.append('category', 'digital_human');
      try {
        const r = await fetch(API + '/upload', { method: 'POST', body: fd });
        const j = await r.json();
        if (j.status === 200) document.getElementById('dh_image').value = j.data.path;
        else toast('上传失败：' + (j.message || ''), true);
      } catch (err) { toast(err.message, true); }
    };

    document.getElementById('dh_generate').onclick = () => this.generate();
  },
  async _loadTtsServices() {
    try {
      const data = await api('GET', '/agent/tts/services');
      this._dhServices = data.services || [];
      const cur = data.current_service || '';
      const curVoice = data.current_voice || '';
      const sel = document.getElementById('dh_service');
      sel.innerHTML = this._dhServices.map(s =>
        `<option value="${esc(s.id)}"${s.id === cur ? ' selected' : ''}${s.planned ? ' disabled' : ''}>${esc(s.label || s.id)}${s.channel === 'local' ? '（本地）' : ''}${s.planned ? '（待接入）' : ''}</option>`
      ).join('');
      const fillVoices = () => {
        const svc = this._dhServices.find(s => s.id === sel.value);
        const voices = (svc && svc.voices) || [];
        const vSel = document.getElementById('dh_voice');
        vSel.innerHTML = voices.length
          ? voices.map(v => `<option value="${esc(v)}"${v === curVoice ? ' selected' : ''}>${esc(v)}</option>`).join('')
          : '<option value="">该服务无可用音色</option>';
      };
      sel.onchange = fillVoices;
      fillVoices();
    } catch (e) {
      document.getElementById('dh_service').innerHTML = '<option value="">加载失败</option>';
    }
  },
  async generate() {
    const btn = document.getElementById('dh_generate');
    const text = document.getElementById('dh_text').value.trim();
    const image = document.getElementById('dh_image').value.trim();
    const personaId = document.getElementById('dh_persona').value;
    const provider = document.getElementById('dh_provider').value;
    const voice = document.getElementById('dh_voice').value.trim();
    if (!text) { toast('请填写口播文案', true); return; }
    if (!personaId && !image) { toast('请上传肖像图，或选择带数字人形象的人设', true); return; }

    btn.disabled = true;
    this._showProg(5, '提交生成任务…');
    const body = {
      text,
      voice_name: voice || 'zh-CN-XiaoxiaoNeural-Female',
      voice_rate: parseFloat(document.getElementById('dh_rate').value) || 1.0,
      voice_volume: parseFloat(document.getElementById('dh_volume').value) || 1.0,
    };
    if (personaId) body.persona_id = personaId;
    else { body.provider = provider; body.image_path = image; }

    try {
      const res = await fetch(API + '/agent/digital-human/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j && j.message) || ('请求失败 ' + res.status));
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          let evt;
          try { evt = JSON.parse(dataLine.slice(6)); } catch { continue; }
          if (evt.type === 'progress') {
            this._showProg(evt.pct || 0, evt.msg || '');
          } else if (evt.type === 'done') {
            const d = evt.data || {};
            this._showProg(100, '生成完成 ✓');
            const box = document.getElementById('dh_result');
            box.classList.remove('hidden');
            document.getElementById('dh_video').src = d.video_url || '';
            toast('数字人视频已生成');
          } else if (evt.type === 'error') {
            this._showProg(100, '失败：' + (evt.message || '未知错误'));
            toast('生成失败：' + (evt.message || '未知错误'), true);
          }
        }
      }
    } catch (e) {
      this._showProg(100, '请求失败：' + e.message);
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
  },
  _showProg(pct, stage) {
    const wrap = document.getElementById('dh_prog');
    wrap.classList.remove('hidden');
    document.getElementById('dh_progBar').style.width = Math.max(0, Math.min(100, pct)) + '%';
    document.getElementById('dh_progPct').textContent = Math.round(pct) + '%';
    if (stage) document.getElementById('dh_progStage').textContent = stage;
  },
};

/* ===== 对标仿写 ===== */
VIEWS.reference = {
  html() {
    return `
      <h1>对标仿写</h1>
      <p class="sub">上传本地视频/音频、粘贴对标文案或给链接，自动转写并做语义级仿写，产出自己的口播稿。</p>
      <div class="card">
        <div class="field">
          <label>对标来源（三选一）</label>
          <div class="seg" id="r_modeSeg" style="margin-bottom:10px">
            <button data-mode="upload" class="active">上传本地文件</button>
            <button data-mode="link">链接</button>
            <button data-mode="paste">粘贴文案</button>
          </div>
          <div id="r_uploadBox">
            <input type="file" id="r_file" accept="video/*,audio/*" />
            <p class="muted" id="r_uploadHint" style="margin:6px 0 0">选择视频/音频后自动上传到服务器并转写（支持 mp4/mov/mkv/webm/avi/mp3/wav 等）</p>
          </div>
          <div id="r_linkBox" class="hidden">
            <input id="r_source" placeholder="可填视频直链，或直接粘贴抖音/小红书等「分享文案」"/>
            <p class="muted" style="margin:6px 0 0">粘贴抖音/小红书等「复制链接」分享文本时，会先尝试下载完整视频并用本地 whisper 转写全文，再做仿写；若平台拦截下载，则自动回退用标题文案仿写。</p>
          </div>
          <div id="r_pasteBox" class="hidden">
            <textarea id="r_transcript" placeholder="直接粘贴已转写的对标口播文案"></textarea>
          </div>
        </div>
        <div class="row">
          <div class="field" style="max-width:320px"><label>人设（可选）</label><select id="r_persona"><option value="">不指定</option></select></div>
          <div class="field" style="max-width:200px"><label>语言</label><input id="r_lang" placeholder="如 zh"/></div>
        </div>
        <button class="btn" id="r_run">开始仿写</button>
      </div>
      <div id="r_out" class="card hidden" style="margin-top:16px"></div>`;
  },
  init() {
    let refUploadedPath = null;  // 已上传到服务端的绝对路径
    api('GET', '/agent/personas').then(list => {
      const sel = document.getElementById('r_persona');
      (list || []).forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name || p.id; sel.appendChild(o); });
    }).catch(() => {});

    // 来源方式切换
    const seg = document.getElementById('r_modeSeg');
    seg.querySelectorAll('button').forEach(b => b.onclick = () => {
      seg.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const m = b.dataset.mode;
      document.getElementById('r_uploadBox').classList.toggle('hidden', m !== 'upload');
      document.getElementById('r_linkBox').classList.toggle('hidden', m !== 'link');
      document.getElementById('r_pasteBox').classList.toggle('hidden', m !== 'paste');
    });

    // 选文件 -> 自动上传到服务端（复刻 Streamlit st.file_uploader 的本地文件模式）
    document.getElementById('r_file').onchange = async () => {
      const inp = document.getElementById('r_file');
      const hint = document.getElementById('r_uploadHint');
      if (!inp.files.length) { refUploadedPath = null; return; }
      hint.textContent = '上传中…';
      const fd = new FormData();
      fd.append('file', inp.files[0]);
      fd.append('category', 'misc');
      try {
        const r = await fetch(API + '/upload', { method: 'POST', body: fd });
        const j = await r.json();
        if (j && j.status === 200) {
          refUploadedPath = j.data.path;
          hint.textContent = '已上传：' + j.data.file + '（点击「开始仿写」转写并仿写）';
        } else {
          refUploadedPath = null;
          hint.textContent = '上传失败：' + ((j && j.message) || '未知错误');
        }
      } catch (e) {
        refUploadedPath = null;
        hint.textContent = '上传失败：' + e.message;
      }
    };

    document.getElementById('r_run').onclick = async () => {
      const mode = document.querySelector('#r_modeSeg .active').dataset.mode;
      const body = {
        source: null,
        transcript_text: null,
        persona_id: document.getElementById('r_persona').value || null,
        language: document.getElementById('r_lang').value.trim() || null,
      };
      if (mode === 'upload') {
        if (!refUploadedPath) { toast('请先选择并等待本地文件上传完成', true); return; }
        body.source = refUploadedPath;
      } else if (mode === 'paste') {
        const t = document.getElementById('r_transcript').value.trim();
        if (!t) { toast('请粘贴对标文案', true); return; }
        body.transcript_text = t;
      } else { // link
        const s = document.getElementById('r_source').value.trim();
        if (!s) { toast('请填写对标链接', true); return; }
        body.source = s;
      }
      const runBtn = document.getElementById('r_run');
      const box = document.getElementById('r_out');
      runBtn.disabled = true; runBtn.classList.add('disabled');
      box.classList.remove('hidden');
      box.innerHTML = `
        <div class="rprog-wrap">
          <div class="rprog-stage" id="rprogStage">准备中…</div>
          <div class="rprog"><div class="rprog-bar" id="rprogBar" style="width:6%"></div></div>
          <div class="rprog-pct" id="rprogPct">6%</div>
        </div>`;
      const setProg = (pct, msg) => {
        const bar = document.getElementById('rprogBar');
        const stage = document.getElementById('rprogStage');
        const pctEl = document.getElementById('rprogPct');
        if (bar) bar.style.width = Math.max(6, Math.min(100, pct)) + '%';
        if (stage && msg) stage.textContent = msg;
        if (pctEl) pctEl.textContent = Math.max(6, Math.min(100, pct)) + '%';
      };
      try {
        const res = await fetch(API + '/agent/reference/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok || !res.body) {
          const j = await res.json().catch(() => ({}));
          throw new Error((j && j.message) || ('请求失败 ' + res.status));
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue;
            let evt;
            try { evt = JSON.parse(dataLine.slice(6)); } catch { continue; }
            if (evt.type === 'progress') {
              setProg(evt.pct, evt.msg);
            } else if (evt.type === 'done') {
              const d = evt.data;
              setProg(100, '完成 ✓');
              box.innerHTML = `
                <h3 style="margin-top:0">转写文本</h3><div class="code">${esc(d.transcript || d.transcript_text || '（无）')}</div>
                <h3>仿写口播稿</h3><div class="code code-lg">${esc(d.rewritten_script || '（无）')}</div>`;
            } else if (evt.type === 'error') {
              setProg(100, '失败');
              box.innerHTML = '<p class="tag bad">失败：' + esc(evt.message) + '</p>';
            }
          }
        }
      } catch (e) {
        setProg(100, '失败');
        box.innerHTML = '<p class="tag bad">失败：' + esc(e.message) + '</p>';
      } finally {
        runBtn.disabled = false; runBtn.classList.remove('disabled');
      }
    };
  },
};

/* ===== 资产管理 ===== */
VIEWS.assets = {
  html() {
    return `
      <h1>资产管理</h1>
      <p class="sub">集中管理客户上传的图片、声音、视频，按分类保存，供生成任务直接引用。</p>
      <div class="card" style="margin-bottom:16px">
        <div class="field">
          <label>上传文件（图片 / 声音 / 视频）</label>
          <input type="file" id="a_file" accept="image/*,audio/*,video/*" />
        </div>
        <div class="row">
          <div class="field" style="flex:1">
            <label>分类（如：客户A / 产品图 / 配音）</label>
            <input id="a_cat" list="a_catList" placeholder="输入或选择已有分类" />
            <datalist id="a_catList"></datalist>
          </div>
          <div class="field" style="flex:2">
            <label>名称（可选，留空用文件名）</label>
            <input id="a_name" placeholder="如：品牌主视觉" />
          </div>
        </div>
        <button class="btn" id="a_upload">上传并保存</button>
      </div>
      <div class="hist-filter">
        <div class="seg2" id="a_typeSeg">
          <button data-type="" class="active">全部</button>
          <button data-type="image">图片</button>
          <button data-type="audio">声音</button>
          <button data-type="video">视频</button>
        </div>
        <select id="a_catFilter"><option value="">全部分类</option></select>
        <span class="muted" id="a_count" style="margin-left:auto"></span>
      </div>
      <div id="a_list"></div>`;
  },
  init() {
    const seg = document.getElementById('a_typeSeg');
    let curType = '';
    let curCat = '';
    seg.querySelectorAll('button').forEach(b => b.onclick = () => {
      seg.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      curType = b.dataset.type;
      this.load(curType, curCat);
    });
    document.getElementById('a_catFilter').onchange = e => { curCat = e.target.value; this.load(curType, curCat); };
    document.getElementById('a_upload').onclick = () => this.upload();
    this.refreshCats();
    this.load('', '');
  },
  async refreshCats() {
    try {
      const cats = await api('GET', '/agent/assets/categories');
      const sel = document.getElementById('a_catFilter');
      const dl = document.getElementById('a_catList');
      const cur = sel.value;
      sel.innerHTML = '<option value="">全部分类</option>' + (cats || []).map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
      sel.value = cur;
      dl.innerHTML = (cats || []).map(c => `<option value="${esc(c)}"></option>`).join('');
    } catch (e) { /* 忽略分类加载失败 */ }
  },
  async upload() {
    const inp = document.getElementById('a_file');
    if (!inp.files.length) { toast('请先选择文件', true); return; }
    const fd = new FormData();
    fd.append('file', inp.files[0]);
    fd.append('category', document.getElementById('a_cat').value.trim());
    fd.append('name', document.getElementById('a_name').value.trim());
    const btn = document.getElementById('a_upload');
    btn.disabled = true;
    try {
      const r = await fetch(API + '/agent/assets', { method: 'POST', body: fd });
      const j = await r.json();
      if (j && j.status === 200) {
        toast('已保存：' + (j.data.name || ''));
        inp.value = '';
        document.getElementById('a_cat').value = '';
        document.getElementById('a_name').value = '';
        this.refreshCats();
        this.load('', '');
      } else {
        toast('上传失败：' + ((j && j.message) || '未知错误'), true);
      }
    } catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; }
  },
  async load(type, cat) {
    const box = document.getElementById('a_list');
    try {
      const q = [];
      if (type) q.push('type=' + encodeURIComponent(type));
      if (cat) q.push('category=' + encodeURIComponent(cat));
      const list = await api('GET', '/agent/assets' + (q.length ? '?' + q.join('&') : ''));
      document.getElementById('a_count').textContent = (list || []).length + ' 个资产';
      if (!list.length) { box.innerHTML = '<p class="muted">暂无资产，先在上方上传并保存。</p>'; return; }
      const groups = {};
      list.forEach(a => { (groups[a.category] = groups[a.category] || []).push(a); });
      box.innerHTML = Object.keys(groups).sort().map(catName => `
        <h3 style="margin:18px 0 8px">${esc(catName)} <span class="muted" style="font-weight:400;font-size:12px">· ${groups[catName].length}</span></h3>
        <div class="asset-grid">
          ${groups[catName].map(a => this.card(a)).join('')}
        </div>`).join('');
      box.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (!confirm('确认删除该资产？')) return;
        try { await api('DELETE', '/agent/assets/' + b.dataset.del); toast('已删除'); this.load(type, cat); }
        catch (e) { toast(e.message, true); }
      });
      // 媒体加载失败（孤儿记录/编码异常）优雅降级，避免黑框
      box.querySelectorAll('img.asset-thumb, video.asset-media').forEach(el => {
        el.addEventListener('error', () => {
          const prev = el.closest('.asset-prev');
          if (prev) prev.innerHTML = '<div class="asset-file">预览不可用</div>';
        });
      });
      // 点击图片放大查看（复用全局 openLightbox）
      box.querySelectorAll('img.asset-thumb[data-full]').forEach(el => {
        el.addEventListener('click', () => openLightbox(el.dataset.full, el.dataset.name));
      });
    } catch (e) { box.innerHTML = '<p class="muted">加载失败：' + esc(e.message) + '</p>'; }
  },
  card(a) {
    const url = assetUrl(a.path);
    let preview;
    if (a.exists === false) preview = '<div class="asset-file">⚠ 文件缺失（已被删除，可删除此记录）</div>';
    else if (a.type === 'image' && url) preview = `<img class="asset-thumb" src="${esc(url)}" data-full="${esc(url)}" data-name="${esc(a.name)}" style="cursor:zoom-in" alt=""/>`;
    else if (a.type === 'audio' && url) preview = `<audio class="asset-media" controls src="${esc(url)}"></audio>`;
    else if (a.type === 'video' && url) preview = `<video class="asset-media" controls src="${esc(url)}"></video>`;
    else preview = `<div class="asset-file">📄 ${esc(a.file || a.name)}</div>`;
    const typeLabel = { image: '图片', audio: '声音', video: '视频', file: '文件' }[a.type] || a.type;
    return `
      <div class="asset-card">
        <div class="asset-prev">${preview}</div>
        <div class="asset-meta">
          <div class="asset-name" title="${esc(a.name)}">${esc(a.name)}</div>
          <div class="muted" style="font-size:12px">${typeLabel} · ${fmtSize(a.size)}</div>
        </div>
        <button class="btn sm danger" data-del="${esc(a.id)}">删除</button>
      </div>`;
  },
};

/* ===== 合规检测 ===== */
VIEWS.compliance = {
  html() {
    return `
      <h1>合规检测</h1>
      <p class="sub">对文案/标题做违禁词检测，分级（阻断/提示）并给出改写建议。</p>
      <div class="card">
        <div class="field"><label>检测文案</label><textarea id="c_script" placeholder="输入待检测口播文案"></textarea></div>
        <div class="field"><label>标题（可选）</label><input id="c_title"/></div>
        <button class="btn" id="c_run">检测</button>
      </div>
      <div id="c_out" class="card hidden" style="margin-top:16px"></div>
      <div class="grid cols-2" style="margin-top:16px">
        <div class="card">
          <h3 style="margin-top:0">词库概览</h3>
          <div id="c_stats" class="muted">加载中…</div>
        </div>
        <div class="card">
          <h3 style="margin-top:0">自定义违禁词</h3>
          <div id="c_words" class="muted"></div>
          <div class="row" style="margin-top:8px">
            <input id="c_newword" placeholder="每行一条：模式 | 级别 | 建议 | 变体"/>
            <button class="btn sm" id="c_add">添加</button>
          </div>
          <button class="btn sm ghost" id="c_reload" style="margin-top:8px">热重载词库</button>
        </div>
      </div>`;
  },
  init() {
    document.getElementById('c_run').onclick = async () => {
      const body = { script: document.getElementById('c_script').value, title: document.getElementById('c_title').value || null };
      const box = document.getElementById('c_out'); box.classList.remove('hidden');
      box.innerHTML = '<p class="muted">检测中…</p>';
      try {
        const d = await api('POST', '/agent/compliance/check', body);
        const hits = d.hits || [];
        let html = `<div>结果：${d.passed ? '<span class="tag ok">通过</span>' : '<span class="tag bad">发现命中</span>'}</div>`;
        if (hits.length) {
          html += '<table style="margin-top:10px"><thead><tr><th>级别</th><th>命中</th><th>建议</th></tr></thead><tbody>' +
            hits.map(h => `<tr><td>${stateTag(h.level === 'block' ? '-1' : '5').replace(/待处理|处理中|完成|复审|已取消/g, h.level === 'block' ? '阻断' : '提示')}</td><td>${esc(h.word)}</td><td class="muted">${esc(h.suggestion || '')}</td></tr>`).join('') + '</tbody></table>';
        } else html += '<p class="muted">未发现违禁词。</p>';
        box.innerHTML = html;
      } catch (e) { box.innerHTML = '<p class="tag bad">失败：' + esc(e.message) + '</p>'; }
    };
    this.loadStats(); this.loadWords();
    document.getElementById('c_add').onclick = async () => {
      const v = document.getElementById('c_newword').value.trim();
      if (!v) return;
      try { await api('POST', '/agent/compliance/custom-words', { words: v.split('\n') }); toast('已添加'); document.getElementById('c_newword').value = ''; this.loadWords(); }
      catch (e) { toast(e.message, true); }
    };
    document.getElementById('c_reload').onclick = async () => {
      try { await api('POST', '/agent/compliance/reload'); toast('词库已重载'); this.loadStats(); }
      catch (e) { toast(e.message, true); }
    };
  },
  async loadStats() {
    try {
      const [ind, stats] = await Promise.all([api('GET', '/agent/compliance/industries'), api('GET', '/agent/compliance/stats')]);
      const s = stats || {};
      const total = Object.values(s).reduce((a, b) => a + (b || 0), 0);
      document.getElementById('c_stats').innerHTML = `已加载 <b>${total}</b> 条规则，覆盖 <b>${(ind || []).length}</b> 个行业。`;
    } catch (e) { document.getElementById('c_stats').textContent = '加载失败：' + e.message; }
  },
  async loadWords() {
    const box = document.getElementById('c_words');
    try {
      const list = await api('GET', '/agent/compliance/custom-words');
      if (!list || !list.length) { box.innerHTML = '<p class="muted">暂无自定义词。</p>'; return; }
      box.innerHTML = list.map(w => `<div style="display:flex;justify-content:space-between;gap:8px"><span class="code" style="flex:1">${esc(w)}</span><button class="btn sm danger" data-w="${encodeURIComponent(w)}">删</button></div>`).join('');
      box.querySelectorAll('[data-w]').forEach(b => b.onclick = async () => {
        try { await api('DELETE', '/agent/compliance/custom-words?word=' + b.dataset.w); toast('已删除'); this.loadWords(); }
        catch (e) { toast(e.message, true); }
      });
    } catch (e) { box.innerHTML = '<p class="muted">加载失败：' + e.message + '</p>'; }
  },
};

/* ===== 标题封面 ===== */
VIEWS.titlecover = {
  html() {
    return `
      <h1>标题封面</h1>
      <p class="sub">基于主题/文案生成吸睛标题、话题标签与封面图（可选人设语气）。</p>
      <div class="card">
        <div class="field"><label>视频主题</label><input id="t_subject" placeholder="与生成时一致的主题"/></div>
        <div class="field"><label>视频文案（可选）</label><textarea id="t_script"></textarea></div>
        <div class="row">
          <div class="field" style="max-width:320px"><label>人设（可选）</label><select id="t_persona"><option value="">不指定</option></select></div>
          <div class="field" style="max-width:200px"><label>语言</label><input id="t_lang" placeholder="如 zh"/></div>
        </div>
        <div class="row">
          <div class="field" style="max-width:220px"><label>封面引擎</label><select id="t_engine"><option value="">默认</option><option value="local">本地(PIL)</option><option value="cloud">云端</option></select></div>
          <div class="field" style="max-width:160px"><label>合成片头</label><input type="checkbox" id="t_compose" style="width:auto"/></div>
        </div>
        <button class="btn" id="t_run">生成</button>
      </div>
      <div id="t_out" class="card hidden" style="margin-top:16px"></div>`;
  },
  init() {
    api('GET', '/agent/personas').then(list => {
      const sel = document.getElementById('t_persona');
      (list || []).forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name || p.id; sel.appendChild(o); });
    }).catch(() => {});
    document.getElementById('t_run').onclick = async () => {
      const body = {
        video_subject: document.getElementById('t_subject').value,
        video_script: document.getElementById('t_script').value,
        language: document.getElementById('t_lang').value.trim() || null,
        persona_id: document.getElementById('t_persona').value || null,
        engine: document.getElementById('t_engine').value || null,
        compose: document.getElementById('t_compose').checked,
      };
      if (!body.video_subject) { toast('请填写视频主题', true); return; }
      const box = document.getElementById('t_out'); box.classList.remove('hidden'); box.innerHTML = '<p class="muted">生成中…</p>';
      try {
        const d = await api('POST', '/agent/title-cover/generate', body);
        const cover = assetUrl(d.cover_path);
        const tags = (d.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join(' ');
        box.innerHTML = `<h3 style="margin-top:0">标题</h3><div class="code">${esc(d.title || '')}</div>
          <h3>话题标签</h3><div class="pill-row">${tags || '<span class="muted">无</span>'}</div>
          ${cover ? `<h3>封面（点击放大）</h3><img class="cover-thumb" src="${esc(cover)}" alt="封面"/>` : `<p class="muted">封面路径：${esc(d.cover_path || '无')}</p>`}`;
        const ci = box.querySelector('img.cover-thumb');
        if (ci) ci.onclick = () => openLightbox(ci.src, '封面');
      } catch (e) { box.innerHTML = '<p class="tag bad">失败：' + esc(e.message) + '</p>'; }
    };
  },
};

/* ===== 素材查找（Pexels 图片/视频，口播视频配色） ===== */
VIEWS.stock = {
  html() {
    return `
      <div class="stk">
        <div class="stk-head">
          <div>
            <h1>素材查找</h1>
            <p class="sub">粘贴口播文案，AI 提取英文关键词，一键搜索 Pexels 图片 / 视频，下载后自动进入「资产管理」。</p>
          </div>
        </div>
        <div class="stk-panel">
          <div class="stk-block">
            <label>口播文案</label>
            <textarea id="sk_text" class="stk-input" rows="4" placeholder="粘贴整段口播文案，AI 将提取适合搜素材的英文关键词…"></textarea>
            <div class="stk-row">
              <button class="stk-btn primary" id="sk_termsBtn">AI 提取关键词</button>
              <span class="stk-muted" id="sk_termsHint"></span>
            </div>
            <div id="sk_chips" class="stk-chips"></div>
          </div>
          <div class="stk-block">
            <label>搜索</label>
            <div class="stk-row">
              <input id="sk_query" class="stk-input" style="flex:1" placeholder="输入英文关键词，如 city night timelapse"/>
              <div class="stk-seg" id="sk_kindSeg">
                <button data-kind="photo" class="active">图片</button>
                <button data-kind="video">视频</button>
              </div>
              <button class="stk-btn primary" id="sk_searchBtn">搜索</button>
            </div>
          </div>
        </div>
        <div id="sk_status" class="stk-muted" style="padding:12px 4px"></div>
        <div id="sk_results" class="stk-grid"></div>
        <div id="sk_pager" class="stk-pager"></div>
      </div>`;
  },
  init() {
    this.kind = 'photo';
    this.page = 1;
    this.total = 0;
    this.query = '';
    const seg = document.getElementById('sk_kindSeg');
    seg.querySelectorAll('button').forEach(b => b.onclick = () => {
      seg.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      this.kind = b.dataset.kind;
      if (this.query) this.search(1);
    });
    document.getElementById('sk_termsBtn').onclick = () => this.extractTerms();
    document.getElementById('sk_searchBtn').onclick = () => {
      const q = document.getElementById('sk_query').value.trim();
      if (!q) { toast('请输入搜索关键词', true); return; }
      this.search(1);
    };
    document.getElementById('sk_query').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this.search(1); }
    });
  },
  async extractTerms() {
    const text = document.getElementById('sk_text').value.trim();
    const hint = document.getElementById('sk_termsHint');
    const btn = document.getElementById('sk_termsBtn');
    if (!text) { toast('请先粘贴口播文案', true); return; }
    btn.disabled = true;
    hint.textContent = 'AI 提取中…';
    try {
      const d = await api('POST', '/stock/terms', { text, amount: 6 });
      if (!d.ok) { hint.textContent = d.message || '提取失败'; toast(d.message || '提取失败', true); return; }
      hint.textContent = '已用第一个关键词自动搜索，点击其他关键词可切换：';
      const chips = document.getElementById('sk_chips');
      chips.innerHTML = (d.terms || []).map(t =>
        `<button class="stk-chip" data-q="${esc(t)}">${esc(t)}</button>`).join('');
      chips.querySelectorAll('button').forEach(b => b.onclick = () => {
        document.getElementById('sk_query').value = b.dataset.q;
        this.search(1);
      });
      // 自动填入第一个关键词并立即搜索
      const terms = d.terms || [];
      if (terms.length) {
        document.getElementById('sk_query').value = terms[0];
        this.search(1);
      }
    } catch (e) {
      hint.textContent = '';
      toast('关键词提取失败：' + e.message, true);
    } finally { btn.disabled = false; }
  },
  async search(page) {
    this.query = document.getElementById('sk_query').value.trim();
    if (!this.query) { toast('请输入搜索关键词', true); return; }
    this.page = page || 1;
    const status = document.getElementById('sk_status');
    const box = document.getElementById('sk_results');
    const pager = document.getElementById('sk_pager');
    status.textContent = `正在搜索 ${this.kind === 'photo' ? '图片' : '视频'}：${this.query} …`;
    box.innerHTML = '';
    pager.innerHTML = '';
    try {
      const d = await api('POST', '/stock/search', {
        query: this.query, kind: this.kind, page: this.page, per_page: 24,
      });
      if (!d.ok) {
        status.textContent = d.message || '搜索失败';
        toast(d.message || '搜索失败', true);
        return;
      }
      this.total = d.total || 0;
      status.textContent = `「${this.query}」共 ${this.total} 条结果 · 第 ${this.page} 页`;
      if (!d.items || !d.items.length) {
        box.innerHTML = '<div class="stk-empty">未找到相关素材，换个关键词试试。</div>';
        return;
      }
      box.innerHTML = d.items.map((it, i) => it.type === 'photo'
        ? this.photoCard(it, i)
        : this.videoCard(it, i)).join('');
      this.bindCards(d.items);
      this.renderPager();
    } catch (e) {
      status.textContent = '';
      toast('搜索失败：' + e.message, true);
    }
  },
  photoCard(it, i) {
    return `
      <div class="stk-card" data-i="${i}">
        <div class="stk-media"><img src="${esc(it.thumb || '')}" loading="lazy" alt=""/></div>
        <div class="stk-meta">
          <span class="stk-author" title="${esc(it.author)}">${esc(it.author || 'Pexels')}</span>
          <span class="stk-dim">${esc(it.width || '?')}×${esc(it.height || '?')}</span>
        </div>
        <div class="stk-actions">
          <button class="stk-btn sm" data-act="preview">预览</button>
          <button class="stk-btn sm primary" data-act="download">下载到资产</button>
          ${it.page_url ? `<a class="stk-btn sm ghost" href="${esc(it.page_url)}" target="_blank" rel="noopener">来源</a>` : ''}
        </div>
      </div>`;
  },
  videoCard(it, i) {
    const dur = it.duration ? `${Math.round(it.duration)}s` : '';
    return `
      <div class="stk-card" data-i="${i}">
        <div class="stk-media stk-video" data-src="${esc(it.preview || '')}">
          <img src="${esc(it.thumb || '')}" loading="lazy" alt=""/>
          ${it.preview ? '<span class="stk-play">▶</span>' : ''}
          ${dur ? `<span class="stk-dur">${esc(dur)}</span>` : ''}
        </div>
        <div class="stk-meta">
          <span class="stk-author" title="${esc(it.author)}">${esc(it.author || 'Pexels')}</span>
          <span class="stk-dim">${esc(it.width || '?')}×${esc(it.height || '?')}</span>
        </div>
        <div class="stk-actions">
          <button class="stk-btn sm primary" data-act="download">下载到资产</button>
          ${it.page_url ? `<a class="stk-btn sm ghost" href="${esc(it.page_url)}" target="_blank" rel="noopener">来源</a>` : ''}
        </div>
      </div>`;
  },
  bindCards(items) {
    document.querySelectorAll('#sk_results .stk-card').forEach(card => {
      const it = items[parseInt(card.dataset.i, 10)];
      if (!it) return;
      card.querySelectorAll('button[data-act]').forEach(b => b.onclick = async () => {
        if (b.dataset.act === 'preview') {
          openLightbox(it.full || it.thumb, `${it.author || 'Pexels'} · ${it.width || ''}×${it.height || ''}`);
          return;
        }
        // download
        const url = it.type === 'photo' ? it.full : (it.preview || (it.files && it.files[0] && it.files[0].link) || '');
        if (!url) { toast('该素材没有可下载的文件', true); return; }
        b.disabled = true;
        const old = b.textContent;
        b.textContent = '下载中…';
        try {
          const d = await api('POST', '/stock/download', { url, kind: it.type, name: '' });
          if (!d.ok) { toast(d.message || '下载失败', true); b.textContent = old; b.disabled = false; return; }
          b.textContent = '已存入资产';
          toast('已下载到资产管理（分类：素材查找）：' + (d.asset && d.asset.name || ''));
        } catch (e) {
          toast('下载失败：' + e.message, true);
          b.textContent = old;
          b.disabled = false;
        }
      });
      // 视频卡片：点击封面切换为内联播放
      const vm = card.querySelector('.stk-video');
      if (vm && vm.dataset.src) {
        vm.onclick = () => {
          if (vm.dataset.loaded) return;
          vm.dataset.loaded = '1';
          vm.innerHTML = `<video src="${esc(vm.dataset.src)}" poster="${esc(it.thumb || '')}" controls autoplay playsinline></video>`;
          vm.classList.add('playing');
        };
      }
    });
  },
  renderPager() {
    const pager = document.getElementById('sk_pager');
    const per = 24;
    const maxPage = Math.max(1, Math.ceil(this.total / per));
    if (maxPage <= 1) { pager.innerHTML = ''; return; }
    pager.innerHTML = `
      <button class="stk-btn sm" id="sk_prev" ${this.page <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="stk-muted">第 ${this.page} / ${maxPage} 页</span>
      <button class="stk-btn sm" id="sk_next" ${this.page >= maxPage ? 'disabled' : ''}>下一页</button>`;
    const prev = document.getElementById('sk_prev');
    const next = document.getElementById('sk_next');
    if (prev && !prev.disabled) prev.onclick = () => this.search(this.page - 1);
    if (next && !next.disabled) next.onclick = () => this.search(this.page + 1);
  },
};



/* ===== 口播素材（文案输入/AI 生成 → 自动分割 → 导入口播视频工程） ===== */
const KOUCOPY_DRAFT_KEY = 'koucopy_draft_v1';
// 与口播视频工作台（techvideo/src/TalkStudio.tsx）共用的本地工程键：
// 写入后 navigate 到口播视频页，iframe 重新挂载即自动加载该工程。
const TALK_PROJECT_KEY = 'talk_studio_project_v1';

VIEWS.koucopy = {
  _segs: [],            // 分段结果（字符串数组，可编辑）
  _personaList: [],
  _saveTimer: null,
  html() {
    return `
      <h1>口播素材</h1>
      <p class="sub">口播视频的上游工作台：粘贴或 AI 生成口播文案 → 自动分割成段 → 一键生成口播工程，发送到「口播视频」直接开剪。</p>
      <div class="kc-grid">
        <!-- 第 1 列：文案输入 / AI 生成 -->
        <section class="gen-col">
          <h3>文案</h3>
          <div class="field">
            <label>视频主题（AI 生成用）</label>
            <input id="kc_subject" placeholder="例如：三分钟看懂碳中和" />
          </div>
          <div class="field">
            <label>人设（可选，生成时贴合语气）</label>
            <select id="kc_persona"><option value="">不指定</option></select>
          </div>
          <div class="field">
            <button class="btn" id="kc_genBtn" type="button">✨ AI 生成文案</button>
            <p class="muted" style="margin:8px 0 0">已填主题直接生成；仅选人设时自动先生成主题。生成后自动分割。</p>
          </div>
          <div class="field">
            <label>口播文案 <span id="kc_charCount" class="muted"></span></label>
            <textarea id="kc_text" style="min-height:210px" placeholder="粘贴口播稿，或点上方「AI 生成文案」自动生成。&#10;支持手动换行分段：每个自然段内部再按目标段长细切。"></textarea>
          </div>
          <div class="field">
            <label>分割设置</label>
            <div class="inline">
              <span class="muted" style="white-space:nowrap">目标段长</span>
              <input id="kc_target" type="number" min="20" max="120" step="5" value="40" style="flex:0 0 88px;width:88px" />
              <span class="muted" style="white-space:nowrap">字/段</span>
              <button class="btn sm" id="kc_splitBtn" type="button">✂ 自动分割</button>
            </div>
            <p class="muted" style="margin:8px 0 0">按句号/问号/感叹号等断句，合并到接近目标段长；超长单句按逗号二次切分。</p>
          </div>
        </section>

        <!-- 第 2 列：分段结果 -->
        <section class="gen-col">
          <h3>分段结果 <span id="kc_segStat" class="muted" style="font-size:12px;font-weight:400"></span></h3>
          <div class="inline" style="margin-bottom:10px">
            <button class="btn sm ghost" id="kc_resplitBtn" type="button">↻ 按原文重新分割</button>
            <button class="btn sm ghost" id="kc_addSegBtn" type="button">＋ 添加一段</button>
            <button class="btn sm danger" id="kc_clearSegBtn" type="button">清空</button>
          </div>
          <div id="kc_segList" class="kc-seglist"></div>
        </section>

        <!-- 第 3 列：导入口播视频 -->
        <section class="gen-col">
          <h3>导入口播视频</h3>
          <p class="muted" style="line-height:1.7">每段文案将作为口播视频的一个场景写入「旁白」，发送后可在口播视频工作台继续排布章节、挂载口播人像视频并导出成片。</p>
          <div class="field">
            <label class="kc-check">
              <input type="checkbox" id="kc_keepStyle" checked />
              <span>保留工作台现有样式与素材</span>
            </label>
            <p class="muted" id="kc_projState" style="margin:6px 0 0"></p>
          </div>
          <div class="field">
            <button class="btn" id="kc_sendBtn" type="button" style="width:100%;justify-content:center">➤ 发送到口播视频</button>
          </div>
          <div class="field">
            <button class="btn ghost" id="kc_dlBtn" type="button" style="width:100%;justify-content:center">⤓ 下载工程 JSON</button>
            <p class="muted" style="margin:8px 0 0">也可在「口播视频」左侧「工程文件 → 导入工程」手动选择该文件导入。</p>
          </div>
        </section>
      </div>`;
  },
  init() {
    // 人设下拉（供 AI 生成贴合语气）
    api('GET', '/agent/personas').then(list => {
      this._personaList = list || [];
      const sel = document.getElementById('kc_persona');
      if (sel) {
        sel.innerHTML = '<option value="">不指定</option>' +
          this._personaList.map(p => `<option value="${esc(p.id)}">${esc(p.name || p.id)}</option>`).join('');
      }
    }).catch(() => {});
    document.getElementById('kc_genBtn').onclick = () => this.generate();
    document.getElementById('kc_splitBtn').onclick = () => this.splitFromText();
    document.getElementById('kc_resplitBtn').onclick = () => this.splitFromText();
    document.getElementById('kc_addSegBtn').onclick = () => { this._segs.push(''); this.renderSegs(); this.saveDraft(); };
    document.getElementById('kc_clearSegBtn').onclick = () => { this._segs = []; this.renderSegs(); this.saveDraft(); };
    document.getElementById('kc_sendBtn').onclick = () => this.send();
    document.getElementById('kc_dlBtn').onclick = () => this.download();
    const keep = document.getElementById('kc_keepStyle');
    keep.onchange = () => this.renderProjState();
    document.getElementById('kc_text').addEventListener('input', () => { this.updateCharCount(); this.saveDraft(); });
    document.getElementById('kc_target').addEventListener('input', () => this.saveDraft());
    this.renderProjState();
    this.loadDraft();
  },
  destroy() { if (this._saveTimer) clearTimeout(this._saveTimer); },

  // ---- 草稿（防刷新/切页丢失） ----
  loadDraft() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(KOUCOPY_DRAFT_KEY) || 'null'); } catch (e) {}
    if (d) {
      if (typeof d.text === 'string') document.getElementById('kc_text').value = d.text;
      if (d.target) document.getElementById('kc_target').value = d.target;
      if (Array.isArray(d.segs)) this._segs = d.segs.filter(s => typeof s === 'string');
    }
    this.updateCharCount();
    this.renderSegs();
  },
  saveDraft() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(KOUCOPY_DRAFT_KEY, JSON.stringify({
          text: document.getElementById('kc_text').value,
          target: document.getElementById('kc_target').value,
          segs: this._segs,
          savedAt: Date.now(),
        }));
      } catch (e) {}
    }, 500);
  },

  // ---- AI 生成文案（与视频生成页同一套 /llm 接口） ----
  async generate() {
    const subjectEl = document.getElementById('kc_subject');
    let subject = subjectEl.value.trim();
    const personaId = document.getElementById('kc_persona').value;
    const p = this._personaList.find(x => x.id === personaId);
    const btn = document.getElementById('kc_genBtn');
    if (!subject && !p) { toast('请填写视频主题，或选择人设', true); return; }
    btn.disabled = true;
    try {
      if (!subject && p) {
        toast('已选人设，先生成主题…');
        const t = await api('POST', '/llm/topic', {
          persona_name: p.name || '', persona_tone: p.tone || '', video_language: '',
        });
        if (t && t.video_subject) { subject = t.video_subject; subjectEl.value = subject; }
        else { toast('自动生成主题失败，请填写视频主题', true); return; }
      }
      const custom = (p && (p.name || p.tone))
        ? `你是一个名为「${p.name || '未命名'}」的短视频口播博主。口吻要求：${p.tone || '自然亲切'}。请严格贴合该人设的语气与定位撰写口播文案。`
        : '';
      toast('正在生成口播文案…');
      const sb = await api('POST', '/llm/scripts', {
        video_subject: subject,
        video_language: '',
        custom_system_prompt: custom,
        video_script_prompt: '撰写可直接朗读的口播稿：口语化短句，句间用句号/问号/感叹号分隔，不要书面化长句。',
      });
      if (sb && sb.video_script) {
        document.getElementById('kc_text').value = sb.video_script;
        this.updateCharCount();
        this.saveDraft();
        toast('文案已生成，正在自动分割…');
        this.splitFromText();
      } else {
        toast('生成文案失败', true);
      }
    } catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; }
  },

  // ---- 自动分割 ----
  splitFromText() {
    const text = document.getElementById('kc_text').value.trim();
    if (!text) { toast('请先填写或生成口播文案', true); return; }
    const target = Math.max(20, Math.min(120, parseInt(document.getElementById('kc_target').value) || 40));
    const segs = this.splitText(text, target);
    if (!segs.length) { toast('未能分割出有效段落', true); return; }
    this._segs = segs;
    this.renderSegs();
    this.saveDraft();
    toast(`已分割为 ${segs.length} 段`);
  },
  // 规则分割：换行=硬边界；段内按句末标点断句、顺序合并到目标段长；
  // 超长单句先按逗号/顿号在目标长度附近二切，仍超长再按硬长度切。
  splitText(text, target) {
    const paras = String(text).replace(/\r\n?/g, '\n').split(/\n+/).map(s => s.trim()).filter(Boolean);
    const out = [];
    let cur = '';
    const flush = () => { const t = cur.trim(); if (t) out.push(t); cur = ''; };
    const push = (s) => {
      s = s.trim(); if (!s) return;
      if (cur && (cur + s).length > target) flush();
      cur += s;
      if (cur.length >= target) flush();
    };
    for (const para of paras) {
      flush(); // 段落间不合并
      const sents = para.match(/[^。！？!?；;…]*[。！？!?；;…]+|[^。！？!?；;…]+$/g) || [para];
      for (let s of sents) {
        s = s.trim(); if (!s) continue;
        while (s.length > target) {
          let idx = -1;
          for (let k = target; k >= Math.floor(target * 0.4); k--) {
            if (k < s.length && /[，,、：:]/.test(s[k])) { idx = k; break; }
          }
          if (idx > 0) { push(s.slice(0, idx + 1)); s = s.slice(idx + 1); }
          else { push(s.slice(0, target)); s = s.slice(target); }
        }
        push(s);
      }
    }
    flush();
    return out;
  },

  // ---- 分段列表渲染/编辑 ----
  // 估算时长：中文口播约 4 字/秒（30fps），单段 2s~30s 之间。
  estFrames(t) {
    const n = (t || '').trim().length;
    return Math.max(60, Math.min(900, Math.round(n / 4 * 30)));
  },
  renderSegs() {
    const box = document.getElementById('kc_segList');
    if (!box) return;
    if (!this._segs.length) {
      box.innerHTML = '<div class="kc-empty">尚无分段。填写文案后点「自动分割」，或「添加一段」手动创建。</div>';
    } else {
      box.innerHTML = this._segs.map((t, i) => `
        <div class="kc-seg" data-i="${i}">
          <div class="kc-seg-head">
            <span class="kc-seg-idx">${String(i + 1).padStart(2, '0')}</span>
            <span class="muted kc-seg-meta">${t.length} 字 · 约 ${(this.estFrames(t) / 30).toFixed(1)}s</span>
            <span class="kc-seg-acts">
              <button class="kc-act" data-act="up" title="上移">↑</button>
              <button class="kc-act" data-act="down" title="下移">↓</button>
              <button class="kc-act danger" data-act="del" title="删除">✕</button>
            </span>
          </div>
          <textarea data-role="segtext">${esc(t)}</textarea>
        </div>`).join('');
    }
    this.updateSegStat();
    box.querySelectorAll('.kc-seg').forEach(row => {
      const i = parseInt(row.dataset.i);
      row.querySelectorAll('.kc-act').forEach(b => b.onclick = () => this.segAct(i, b.dataset.act));
      const ta = row.querySelector('textarea[data-role="segtext"]');
      ta.addEventListener('input', () => {
        this._segs[i] = ta.value;
        const meta = row.querySelector('.kc-seg-meta');
        if (meta) meta.textContent = `${ta.value.length} 字 · 约 ${(this.estFrames(ta.value) / 30).toFixed(1)}s`;
        this.updateSegStat();
        this.saveDraft();
      });
    });
  },
  segAct(i, act) {
    const a = this._segs;
    if (act === 'del') a.splice(i, 1);
    else if (act === 'up' && i > 0) { [a[i - 1], a[i]] = [a[i], a[i - 1]]; }
    else if (act === 'down' && i < a.length - 1) { [a[i + 1], a[i]] = [a[i], a[i + 1]]; }
    else return;
    this.renderSegs();
    this.saveDraft();
  },
  updateSegStat() {
    const el = document.getElementById('kc_segStat');
    if (!el) return;
    if (!this._segs.length) { el.textContent = ''; return; }
    const chars = this._segs.reduce((a, s) => a + s.trim().length, 0);
    const secs = this._segs.reduce((a, s) => a + this.estFrames(s), 0) / 30;
    el.textContent = `· ${this._segs.length} 段 / 全文 ${chars} 字 / 约 ${secs.toFixed(0)} 秒`;
  },
  updateCharCount() {
    const el = document.getElementById('kc_charCount');
    if (!el) return;
    const t = document.getElementById('kc_text').value;
    el.textContent = t ? `· ${t.replace(/\s/g, '').length} 字` : '';
  },

  // ---- 工程生成与导入 ----
  renderProjState() {
    const el = document.getElementById('kc_projState');
    if (!el) return;
    let p = null;
    try { p = JSON.parse(localStorage.getItem(TALK_PROJECT_KEY) || 'null'); } catch (e) {}
    if (p && Array.isArray(p.scenes) && p.scenes.length) {
      const t = p.savedAt ? new Date(p.savedAt).toLocaleString() : '';
      el.textContent = `检测到口播视频本地工程（${p.scenes.length} 个场景${t ? '，保存于 ' + t : ''}），发送时只替换场景、保留样式。`;
    } else {
      el.textContent = '口播视频暂无本地工程，发送时将按默认样式创建。';
    }
  },
  // 生成 TalkStudio 兼容工程：场景字段与 techvideo/src/TalkStudio.tsx blankScene 对齐
  buildProject() {
    const scenes = this._segs.map(t => ({
      type: 'title', kicker: '', title: '', points: [],
      narration: t, caption: '', quote: '', imageUrl: '',
      durationFrames: this.estFrames(t), animation: 'fade', layout: 'center',
    }));
    let proj = null;
    try { proj = JSON.parse(localStorage.getItem(TALK_PROJECT_KEY) || 'null'); } catch (e) {}
    const keep = document.getElementById('kc_keepStyle') && document.getElementById('kc_keepStyle').checked;
    if (keep && proj && Array.isArray(proj.scenes)) {
      proj.scenes = scenes;
      proj.savedAt = Date.now();
      return proj;
    }
    return {
      app: 'talk-studio', version: 1,
      color1: '#5eead4', color2: '#8aa2ff', bgTheme: 'dark', aspect: '9:16',
      transition: 'fade', videoLayout: 'underlay', showSubtitle: true, showNarration: true,
      exportMode: 'full', videoDim: 0, pipSize: 32, pipPos: 'br',
      personVideo: '', personVideoDuration: 0,
      scenes, savedAt: Date.now(),
    };
  },
  send() {
    const segs = this._segs.map(s => s.trim()).filter(Boolean);
    if (!segs.length) { toast('请先分割或添加分段', true); return; }
    this._segs = segs;
    try { localStorage.setItem(TALK_PROJECT_KEY, JSON.stringify(this.buildProject())); }
    catch (e) { toast('本地工程写入失败', true); return; }
    this.saveDraft();
    toast(`已生成 ${segs.length} 个场景，正在打开口播视频…`);
    navigate('koubo');
  },
  download() {
    const segs = this._segs.map(s => s.trim()).filter(Boolean);
    if (!segs.length) { toast('请先分割或添加分段', true); return; }
    this._segs = segs;
    const blob = new Blob([JSON.stringify(this.buildProject(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `口播工程_${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
    toast('工程 JSON 已下载');
  },
};

/* ===== 口播视频（Overlay Studio 式四区工作台，独立 /koubo/ 入口） ===== */
VIEWS.koubo = {
  html() {
    return `
      <div class="techvideo-wrap koubo-wrap">
        <iframe id="tvFrame" class="techvideo-frame" src="/koubo/?v=${Date.now()}" title="口播视频工作台" loading="lazy" allowfullscreen></iframe>
        <div id="tvFallback" class="card hidden">
          <h3>口播视频静态页面尚未构建</h3>
          <p class="muted">检测到 <code>/koubo/</code> 暂不可访问。请在本项目 <code>techvideo/</code> 目录执行：</p>
          <pre class="code">cd techvideo &amp;&amp; node build.mjs</pre>
          <p class="muted">构建后会生成 <code>resource/public/koubo/</code>，刷新本页即可内嵌使用。</p>
        </div>
      </div>`;
  },
};

/* ===== 历史任务（混剪 + 口播 统一合并视图） ===== */
function taskKind(t) { return (t && t.kind === 'agent') ? 'agent' : 'montage'; }
function taskSubject(t) {
  if (!t) return '';
  if (taskKind(t) === 'agent') {
    const spec = t.spec || {};
    return spec.topic || t.topic || (t.task_id || '').slice(0, 8);
  }
  const p = t.params || {};
  return p.video_subject || (t.task_id || '').slice(0, 8);
}
VIEWS.history = {
  html() {
    return `
      <h1>历史任务</h1>
      <p class="sub">混剪与口播任务的统一视图。两者底层同存于任务状态库，这里合并去重展示，避免在不同页面重复出现。</p>
      <div class="hist-filter">
        <div class="seg2" id="histTabs">
          <button data-f="all" class="active">全部</button>
          <button data-f="montage">混剪</button>
          <button data-f="agent">口播</button>
        </div>
        <button class="btn sm ghost" id="histRefresh" type="button">刷新</button>
      </div>
      <div id="histList" class="card"></div>`;
  },
  init() {
    this._filter = 'all';
    const tabs = document.getElementById('histTabs');
    tabs.querySelectorAll('button').forEach(b => b.onclick = () => {
      tabs.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      this._filter = b.dataset.f;
      this.load();
    });
    document.getElementById('histRefresh').onclick = () => this.load();
    this.load();
    this._timer = setInterval(() => {
      if (document.querySelector('#nav button.active')?.dataset.view === 'history') this.load();
    }, 6000);
  },
  destroy() { if (this._timer) clearInterval(this._timer); },
  async load() {
    const box = document.getElementById('histList');
    if (!box) return;
    try {
      const d = await api('GET', '/tasks?page=1&page_size=200');
      let tasks = (d && d.tasks) || [];
      // 防御性去重（按 task_id），避免任何跨源重复。
      const seen = new Set();
      tasks = tasks.filter(t => { if (seen.has(t.task_id)) return false; seen.add(t.task_id); return true; });
      if (this._filter !== 'all') tasks = tasks.filter(t => taskKind(t) === this._filter);
      // 排序：有时间戳的按时间倒序，否则按 task_id（保留服务端顺序）。
      tasks.sort((a, b) => {
        const ka = b.updated_at || b.created_at || '';
        const kb = a.updated_at || a.created_at || '';
        if (ka || kb) return (ka || '').localeCompare(kb || '');
        return String(b.task_id).localeCompare(String(a.task_id));
      });
      this._tasks = tasks;
      if (!tasks.length) { box.innerHTML = '<p class="muted">暂无任务。</p>'; return; }
      box.innerHTML = '<table><thead><tr><th>类型</th><th>主题</th><th>状态</th><th>进度</th><th>成片</th><th>操作</th></tr></thead><tbody>' +
        tasks.map(t => {
          const kind = taskKind(t);
          const isAgent = kind === 'agent';
          const vids = (!isAgent) ? ((t.videos || []).concat(t.combined_videos || [])) : [];
          const videoCell = isAgent
            ? '<span class="muted">—</span>'
            : videoGallery(vids, true);
          const actions = isAgent
            ? `<button class="btn sm" data-retry="${t.task_id}">重试</button>
               <button class="btn sm ghost" data-review="${t.task_id}">通过</button>
               <button class="btn sm ghost" data-cancel="${t.task_id}">取消</button>
               <button class="btn sm danger" data-del="${t.task_id}">删</button>`
            : `${(t.state == -1 || t.state == 6) ? `<button class="btn sm" data-resubmit="${t.task_id}">重新生成</button> ` : ''}<button class="btn sm danger" data-del="${t.task_id}">删除</button>`;
          return `<tr>
            <td><span class="kind-tag ${kind}">${isAgent ? '口播' : '混剪'}</span></td>
            <td>${esc(taskSubject(t))}</td>
            <td>${stateTag(t.state)}</td>
            <td>${t.progress != null ? t.progress + '%' : ''}</td>
            <td>${videoCell}</td>
            <td>${actions}</td>
          </tr>`;
        }).join('') + '</tbody></table>';
      const run = async (m, id, ex) => {
        try { await api(m, '/agent/tasks/' + id + ex); toast('已执行'); this.load(); }
        catch (e) { toast(e.message, true); }
      };
      box.querySelectorAll('[data-retry]').forEach(b => b.onclick = () => run('POST', b.dataset.retry, '/retry'));
      box.querySelectorAll('[data-review]').forEach(b => b.onclick = () => run('POST', b.dataset.review, '/review'));
      box.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => run('POST', b.dataset.cancel, '/cancel'));
      box.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (!confirm('确认删除该任务？')) return;
        try {
          if (taskKind(this._tasks.find(x => x.task_id === b.dataset.del)) === 'agent')
            await api('DELETE', '/agent/tasks/' + b.dataset.del);
          else await api('DELETE', '/tasks/' + b.dataset.del);
          toast('已删除'); this.load();
        } catch (e) { toast(e.message, true); }
      });
      box.querySelectorAll('[data-resubmit]').forEach(b => b.onclick = () => {
        const t = (this._tasks || []).find(x => x.task_id === b.dataset.resubmit);
        if (t) VIEWS.generate.resubmit(t);
      });
    } catch (e) { box.innerHTML = '<p class="muted">加载失败：' + esc(e.message) + '</p>'; }
  },
};

/* ===== 调度看板 ===== */
VIEWS.scheduler = {
  html() {
    return `
      <h1>调度看板</h1>
      <p class="sub">批量提交口播创作任务，按优先级调度，实时监控与失败重试/人工复审。</p>
      <div id="dash" class="grid cols-3" style="margin-bottom:16px"></div>
      <div class="card" style="margin-bottom:16px">
        <h3 style="margin-top:0">批量提交</h3>
        <div class="field"><label>每行一个任务：主题|渠道|优先级</label><textarea id="s_batch" placeholder="碳中和科普|视频号|5&#10;AI 绘画教程|小红书|3"></textarea></div>
        <div class="row">
          <div class="field" style="max-width:320px"><label>默认人设</label><select id="s_persona"><option value="">不指定</option></select></div>
          <div class="field" style="max-width:200px"><label>素材来源</label><select id="s_source"><option value="local">本地(local_videos)</option><option value="pexels">Pexels</option></select></div>
          <div class="field" style="max-width:220px"><label>批次名</label><input id="s_name" placeholder="可选"/></div>
        </div>
        <button class="btn" id="s_submit">提交批次</button>
      </div>
      <div class="card"><div id="s_tasks"></div></div>`;
  },
  init() {
    api('GET', '/agent/personas').then(list => {
      const sel = document.getElementById('s_persona');
      (list || []).forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name || p.id; sel.appendChild(o); });
    }).catch(() => {});
    document.getElementById('s_submit').onclick = async () => {
      const text = document.getElementById('s_batch').value.trim();
      if (!text) { toast('请填写任务', true); return; }
      const pid = document.getElementById('s_persona').value || null;
      const src = document.getElementById('s_source').value || 'local';
      const tasks = text.split('\n').filter(Boolean).map(line => {
        const [topic, channel, priority] = line.split('|');
        return { topic: topic.trim(), channel: (channel || '').trim() || null, priority: parseInt((priority || '').trim()) || 0, persona_id: pid, params: { video_source: src } };
      });
      try { const d = await api('POST', '/agent/tasks/batch', { tasks, batch_name: document.getElementById('s_name').value.trim() || null }); toast('已提交 ' + d.count + ' 个任务'); this.dash(); this.tasks(); }
      catch (e) { toast(e.message, true); }
    };
    this.dash(); this.tasks();
    this._timer = setInterval(() => { if (document.querySelector('#nav button.active')?.dataset.view === 'scheduler') { this.dash(); this.tasks(); } }, 5000);
  },
  destroy() { if (this._timer) { clearInterval(this._timer); this._timer = null; } },
  async dash() {
    try {
      const d = await api('GET', '/agent/tasks/dashboard');
      const cards = [['total', '总计'], ['pending', '待处理'], ['processing', '处理中'], ['complete', '完成'], ['failed', '失败'], ['review', '复审'], ['cancelled', '取消']];
      document.getElementById('dash').innerHTML = cards.map(([k, l]) => `<div class="stat"><div class="n">${d[k] || 0}</div><div class="l">${l}</div></div>`).join('');
    } catch (e) { document.getElementById('dash').innerHTML = '<p class="muted">加载失败：' + esc(e.message) + '</p>'; }
  },
  async tasks() {
    const box = document.getElementById('s_tasks');
    try {
      const d = await api('GET', '/agent/tasks?page_size=50');
      const tasks = (d && d.tasks) || [];
      if (!tasks.length) { box.innerHTML = '<p class="muted">暂无任务。</p>'; return; }
      box.innerHTML = '<table><thead><tr><th>主题</th><th>状态</th><th>进度</th><th>优先级</th><th>成片</th><th>操作</th></tr></thead><tbody>' +
        tasks.map(t => {
          const vids = (t.videos || []).filter(Boolean);
          const vcell = vids.length
            ? vids.map((v, i) => `<a class="btn sm" href="${esc(v)}" target="_blank" title="成片 ${i + 1}">▶ ${i + 1}</a>`).join(' ')
            : '<span class="muted">—</span>';
          return `<tr>
          <td>${esc(t.topic || t.task_id.slice(0, 8))}</td>
          <td>${stateTag(t.state)}</td>
          <td>${t.progress != null ? t.progress + '%' : ''}</td>
          <td>${t.priority}</td>
          <td>${vcell}</td>
          <td>
            <button class="btn sm" data-retry="${t.task_id}">重试</button>
            <button class="btn sm ghost" data-review="${t.task_id}">通过</button>
            <button class="btn sm ghost" data-cancel="${t.task_id}">取消</button>
            <button class="btn sm danger" data-del="${t.task_id}">删</button>
          </td>
        </tr>`;
        }).join('') + '</tbody></table>';
      const act = async (m, id, extra) => { try { await api(m, '/agent/tasks/' + id + extra); toast('已执行'); this.tasks(); } catch (e) { toast(e.message, true); } };
      box.querySelectorAll('[data-retry]').forEach(b => b.onclick = () => act('POST', b.dataset.retry, '/retry'));
      box.querySelectorAll('[data-review]').forEach(b => b.onclick = () => act('POST', b.dataset.review, '/review'));
      box.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => act('POST', b.dataset.cancel, '/cancel'));
      box.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (!confirm('确认删除？')) return; try { await api('DELETE', '/agent/tasks/' + b.dataset.del); toast('已删除'); this.tasks(); } catch (e) { toast(e.message, true); } });
    } catch (e) { box.innerHTML = '<p class="muted">加载失败：' + esc(e.message) + '</p>'; }
  },
};

/* ===== 系统设置 ===== */
VIEWS.settings = {
  html() {
    return `
      <h1>系统设置</h1>
      <p class="sub">本项目把大模型/视频配置集中在 <code>[app]</code>、配音在各 TTS 服务区段；以下编辑会原子持久化到 config.toml。底部「全部配置区段」含其余区段与专家项。</p>
      <div id="modelCfg" class="card"><p class="muted">加载中…</p></div>
      <div id="vendorCfg" class="card" style="margin-top:16px"></div>
      <div id="uiCfg" class="card" style="margin-top:16px"></div>
      <div id="ttsCfg" class="card" style="margin-top:16px"></div>
      <div id="whisperCfg" class="card" style="margin-top:16px"></div>
      <div style="margin-top:14px"><button class="btn" id="cfgSave">保存配置</button></div>
      <details class="config-sec" style="margin-top:18px"><summary>全部配置区段（专家）</summary><div id="cfgBox" class="card" style="margin-top:8px"></div></details>`;
  },
  init() {
    this.load();
    document.getElementById('cfgSave').onclick = () => this.save();
    this.loadVendors();
  },
  async load() {
    let cfg;
    try { cfg = await api('GET', '/config'); }
    catch (e) { document.getElementById('modelCfg').innerHTML = '<p class="muted">加载失败：' + esc(e.message) + '</p>'; return; }
    const app = cfg.app || {};
    // 常用：大模型 / 视频（来自 [app]）
    const modelKeys = {
      llm_provider: '大模型供应商', openai_api_key: 'OpenAI API Key',
      openai_base_url: 'OpenAI Base URL', openai_model_name: 'OpenAI 模型名',
      video_source: '素材来源', subtitle_provider: '字幕供应商'
    };
    const mk = Object.keys(modelKeys).filter(k => k in app)
      .map(k => `<div class="field"><label>${modelKeys[k]}</label>${fieldInputHTML('app', k, app[k])}</div>`).join('');
    // video_codec 独立下拉
    const codecOptions = ['libx264','h264_nvenc','h264_amf','h264_qsv','h264_mf','h264_videotoolbox'];
    const curCodec = app.video_codec || 'libx264';
    const codecHtml = `<div class="field" style="margin-top:10px"><label>视频编码(video_codec)</label><select data-sec="app" data-key="video_codec">${codecOptions.map(c=>`<option value="${c}" ${c===curCodec?'selected':''}>${c}</option>`).join('')}</select></div>`;
    // Sonilo BGM 供应商（[app] 段内的 sonilo_* 字段）
    const soniloKeys = { sonilo_api_key: 'Sonilo API Key', sonilo_base_url: 'Sonilo Base URL', sonilo_timeout: 'Sonilo 超时(秒)' };
    const soniloHtml = Object.keys(soniloKeys).filter(k => k in app)
      .map(k => `<div class="field"><label>${soniloKeys[k]}</label>${fieldInputHTML('app', k, app[k])}</div>`).join('');
    document.getElementById('modelCfg').innerHTML = `<h3 style="margin-top:0">大模型 / 视频（常用）</h3>` +
      (mk ? `<div class="grid cols-2">${mk}</div>` : '<p class="muted">[app] 区段未找到模型字段。</p>') +
      codecHtml +
      (soniloHtml ? `<h4 style="margin:14px 0 8px;font-size:13px;color:var(--mint)">BGM 供应商 (Sonilo)</h4><div class="grid cols-2">${soniloHtml}</div>` : '');

    // 配音(TTS) 各服务区段（仅标量字段，列表/对象字段为只读）
    const ttsSecs = ['azure', 'siliconflow', 'elevenlabs', 'chatterbox', 'minimax_tts'].filter(s => cfg[s] && typeof cfg[s] === 'object');
    const ttsHtml = ttsSecs.map(sec => {
      const obj = cfg[sec] || {};
      const fields = Object.keys(obj).filter(k => typeof obj[k] !== 'object').map(k =>
        `<div class="field"><label>${esc(sec)}.${esc(k)}</label>${fieldInputHTML(sec, k, obj[k])}</div>`).join('');
      return `<div style="margin-bottom:12px"><h4 style="margin:4px 0 8px;font-size:13px;color:var(--mint)">${esc(sec)}</h4><div class="grid cols-2">${fields}</div></div>`;
    }).join('') || '<p class="muted">未找到 TTS 服务区段。</p>';
    document.getElementById('ttsCfg').innerHTML = `<h3 style="margin-top:0">配音(TTS) 服务</h3>${ttsHtml}`;

    // 界面与字幕 [ui]
    const ui = cfg.ui || {};
    const uiKeys = {
      language: '界面语言(zh/en)', hide_log: '隐藏生成日志',
      open_task_folder_on_completion: '生成后打开任务目录',
      font_name: '字幕字体', font_size: '字幕字号',
      text_fore_color: '字幕文字颜色', subtitle_position: '字幕位置(bottom/top/center/custom)',
      custom_position: '自定义位置(%)', subtitle_background_enabled: '字幕背景填充',
      subtitle_background_color: '字幕背景颜色', rounded_subtitle_background: '字幕背景圆角'
    };
    const uiHtml = Object.keys(uiKeys).filter(k => k in ui).map(k => {
      const v = ui[k];
      if (typeof v === 'boolean') return `<div class="field"><label style="cursor:pointer"><input type="checkbox" data-sec="ui" data-key="${esc(k)}" ${v?'checked':''} style="width:auto;margin-right:6px;vertical-align:middle"/>${uiKeys[k]}</label></div>`;
      return `<div class="field"><label>${uiKeys[k]}</label>${fieldInputHTML('ui', k, v)}</div>`;
    }).join('');
    document.getElementById('uiCfg').innerHTML = `<h3 style="margin-top:0">界面与字幕 (ui)</h3><div class="grid cols-2">${uiHtml}</div>`;

    // Whisper 转写 [whisper]
    const wh = cfg.whisper || {};
    const whKeys = { model_size: '模型大小(large-v3 等)', device: '设备(cpu/cuda)', compute_type: '计算类型(int8/float16)', initial_prompt: '解码偏好词(可选)' };
    const whHtml = Object.keys(whKeys).filter(k => k in wh)
      .map(k => `<div class="field"><label>${whKeys[k]}</label>${fieldInputHTML('whisper', k, wh[k])}</div>`).join('');
    document.getElementById('whisperCfg').innerHTML = `<h3 style="margin-top:0">Whisper 转写</h3><div class="grid cols-2">${whHtml}</div>`;

    // 全部区段（专家）：被上方卡片覆盖的区段/字段不再重复渲染，避免重复输入互相覆盖；
    // 数组/对象字段只读，避免保存时被误写成字符串。
    const skipApp = new Set(['llm_provider', 'openai_api_key', 'openai_base_url', 'openai_model_name', 'video_source', 'subtitle_provider', 'video_codec', 'sonilo_api_key', 'sonilo_base_url', 'sonilo_timeout']);
    const skipUi = new Set(Object.keys(uiKeys));
    const skipSec = new Set(['azure', 'siliconflow', 'elevenlabs', 'chatterbox', 'minimax_tts', 'whisper', 'vendors']);
    const skipMap = { app: skipApp, ui: skipUi };
    const box = document.getElementById('cfgBox');
    box.innerHTML = Object.keys(cfg).sort().filter(sec => !skipSec.has(sec)).map(sec => {
      const obj = cfg[sec] || {};
      const fields = Object.keys(obj).filter(k => !(skipMap[sec] && skipMap[sec].has(k))).map(k => {
        const v = obj[k];
        if (typeof v === 'object' && v !== null) {
          // 敏感字段（API Key 列表等）即使只读也脱敏，不暴露明文
          if (SECRET_RE.test(k)) {
            const n = Array.isArray(v) ? v.length : Object.keys(v).length;
            return `<div class="field"><label>${esc(k)}</label><code class="ro">已隐藏（${Array.isArray(v) ? n + ' 个密钥' : n + ' 项敏感配置'}）</code></div>`;
          }
          return `<div class="field"><label>${esc(k)}</label><code class="ro">${esc(JSON.stringify(v))}</code></div>`;
        }
        return `<div class="field"><label>${esc(k)}</label>${fieldInputHTML(sec, k, v)}</div>`;
      }).join('');
      return `<details class="config-sec" ${sec === 'app' ? 'open' : ''}><summary>${esc(sec)}</summary><div class="body"><div class="grid cols-2">${fields}</div></div></details>`;
    }).join('');
    // 绑定敏感字段「显示/隐藏」按钮（含上方各卡片与专家区段）
    ['modelCfg', 'ttsCfg', 'uiCfg', 'whisperCfg', 'cfgBox'].forEach(id => {
      const el = document.getElementById(id);
      if (el) bindSecretReveal(el);
    });
  },
  async loadVendors() {
    const box = document.getElementById('vendorCfg');
    if (!box) return;
    let d;
    try { d = await api('GET', '/agent/vendors'); }
    catch (e) { box.innerHTML = '<p class="muted">供应商列表加载失败：' + esc(e.message) + '</p>'; return; }
    const vendors = d.vendors || [];
    const cfg = d.config || {};
    if (!vendors.length) { box.innerHTML = '<p class="muted">未登记供应商。</p>'; return; }
    const opts = vendors.map(v => `<option value="${esc(v.vendor_id)}">${esc(v.label)}</option>`).join('');
    box.innerHTML = `<h3 style="margin-top:0">供应商聚合（一家多模型）</h3>
      <p class="sub" style="margin-top:0">同一供应商若同时提供大模型 / 配音 / 数字人，可在此一次填写 API Key，并为每项能力分别指定模型；后台按 (供应商, 能力) 解析对应适配器，原各能力配置作为回退。</p>
      <div class="field" style="max-width:420px"><label>选择供应商</label><select id="vendorSel">${opts}</select></div>
      <div id="vendorForm"></div>
      <button class="btn" id="vendorSave" type="button">保存供应商配置</button>`;
    const sel = document.getElementById('vendorSel');
    const renderForm = () => this._renderVendorForm(vendors, cfg, sel.value);
    sel.onchange = renderForm;
    renderForm();
    document.getElementById('vendorSave').onclick = () => this.saveVendors(vendors);
  },
  _renderVendorForm(vendors, cfg, vid) {
    const v = vendors.find(x => x.vendor_id === vid);
    if (!v) return;
    const vcfg = cfg[vid] || {};
    const caps = vcfg.capabilities || {};
    const base = `data-vsec="vendors" data-vid="${esc(vid)}"`;
    // 共享 API Key 脱敏（password 类型 + 显示/隐藏按钮）；真实值保留在 value，保存时照常提交
    const apiKeyHTML = `<div class="pw"><input type="password" ${base} data-vk="api_key" value="${esc(vcfg.api_key || '')}" placeholder="留空则沿用各能力原有配置"/></div>`;
    let html = `<div class="grid cols-2" style="margin-top:10px">
      <div class="field"><label>共享 API Key</label>${apiKeyHTML}</div>
      <div class="field"><label>共享 Base URL</label><input ${base} data-vk="base_url" value="${esc(vcfg.base_url || '')}" placeholder="${esc(v.default_base_url || '')}"/></div>
    </div>`;
    html += v.capabilities.map(c => {
      const cc = caps[c.capability] || {};
      const isPlanned = c.status === 'planned';
      const disabled = isPlanned ? 'disabled' : '';
      const hint = isPlanned ? ' <span class="muted" style="font-size:11px">（待接入 provider）</span>' : '';
      const capLabel = { llm: 'LLM', tts: '配音', digital_human: '数字人' }[c.capability] || c.capability;
      const mList = `mList_${esc(vid)}_${esc(c.capability)}`;
      const vList = `vList_${esc(vid)}_${esc(c.capability)}`;
      const fetchBtn = isPlanned ? '' :
        `<button type="button" class="btn ghost sm" data-fetch="${esc(c.capability)}" style="align-self:flex-end;margin-bottom:6px">拉取模型/音色</button>`;
      const modelF = `<div class="field"><label>${esc(capLabel)}模型${hint}</label>
        <input ${base} data-cap="${esc(c.capability)}" data-ck="model" id="inp_${mList}" value="${esc(cc.model || '')}" placeholder="${esc(c.default_model || '')}" ${disabled}/>
        <select id="pick_${mList}" ${disabled} style="margin-top:6px;width:100%">
          <option value="">— 拉取后从下拉选择，或手动输入上方 —</option>
        </select></div>`;
      const voiceF = c.capability === 'tts'
        ? `<div class="field"><label>${esc(capLabel)}音色</label>
          <input ${base} data-cap="${esc(c.capability)}" data-ck="voice" id="inp_${vList}" value="${esc(cc.voice || '')}" placeholder="${esc(c.default_voice || '')}" ${disabled}/>
          <select id="pick_${vList}" ${disabled} style="margin-top:6px;width:100%">
            <option value="">— 拉取后从下拉选择，或手动输入上方 —</option>
          </select></div>`
        : '';
      return modelF + voiceF + (fetchBtn ? `<div class="field" style="grid-column:1/-1">${fetchBtn}</div>` : '');
    }).join('');
    document.getElementById('vendorForm').innerHTML = html;
    // 绑定拉取按钮
    document.querySelectorAll('#vendorForm button[data-fetch]').forEach(btn => {
      btn.onclick = () => this.fetchVendorModels(vid, btn.dataset.fetch);
    });
    // 绑定敏感字段「显示/隐藏」按钮
    bindSecretReveal(document.getElementById('vendorForm'));
  },
  async fetchVendorModels(vid, cap) {
    const btn = document.querySelector(`#vendorForm button[data-fetch="${cap}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '拉取中…'; }
    try {
      const d = await api('GET', `/agent/vendors/${encodeURIComponent(vid)}/fetch-models?capability=${encodeURIComponent(cap)}`);
      const models = d.models || [];
      const voices = d.voices || [];
      // 若当前模型/音色为空，自动填入第一个拉到的值，方便直接保存
      const modelInp = document.querySelector(`#vendorForm input[data-cap="${cap}"][data-ck="model"]`);
      const voiceInp = document.querySelector(`#vendorForm input[data-cap="${cap}"][data-ck="voice"]`);
      if (modelInp && !modelInp.value && models.length) modelInp.value = models[0];
      if (voiceInp && !voiceInp.value && voices.length) voiceInp.value = voices[0];
      // 把拉到的清单填入可见下拉（select），让用户能直接点选
      const mListId = `mList_${vid}_${cap}`;
      const vListId = `vList_${vid}_${cap}`;
      const mPick = document.getElementById(`pick_${mListId}`);
      const vPick = document.getElementById(`pick_${vListId}`);
      if (mPick) {
        mPick.innerHTML = models.map(m =>
          `<option value="${esc(m)}" ${modelInp && modelInp.value === m ? 'selected' : ''}>${esc(m)}</option>`
        ).join('') + `<option value="__custom__">自定义…</option>`;
        mPick.onchange = () => {
          if (mPick.value === '__custom__') { if (modelInp) { modelInp.value = ''; modelInp.focus(); } }
          else if (modelInp) { modelInp.value = mPick.value; }
        };
      }
      if (vPick) {
        vPick.innerHTML = voices.map(vv =>
          `<option value="${esc(vv)}" ${voiceInp && voiceInp.value === vv ? 'selected' : ''}>${esc(vv)}</option>`
        ).join('') + `<option value="__custom__">自定义…</option>`;
        vPick.onchange = () => {
          if (vPick.value === '__custom__') { if (voiceInp) { voiceInp.value = ''; voiceInp.focus(); } }
          else if (voiceInp) { voiceInp.value = vPick.value; }
        };
      }
      toast(models.length
        ? `已拉取 ${models.length} 个模型${voices.length ? '、' + voices.length + ' 个音色' : ''}，请选择后保存`
        : '未拉到模型（该供应商可能不支持 /models 接口，请手动填写）');
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '拉取模型/音色'; }
    }
  },
  async saveVendors(vendors) {
    const sel = document.getElementById('vendorSel');
    const vid = sel.value;
    const vblock = { api_key: '', base_url: '', capabilities: {} };
    document.querySelectorAll('#vendorForm input[data-vsec="vendors"]').forEach(inp => {
      if (inp.dataset.vid !== vid) return;
      const vk = inp.dataset.vk, cap = inp.dataset.cap, ck = inp.dataset.ck;
      if (vk) { vblock[vk] = inp.value.trim(); }
      else if (cap && ck) {
        vblock.capabilities[cap] = vblock.capabilities[cap] || {};
        vblock.capabilities[cap][ck] = inp.value.trim();
      }
    });
    if (!vblock.api_key) delete vblock.api_key;
    if (!vblock.base_url) delete vblock.base_url;
    for (const cap in vblock.capabilities) {
      const o = vblock.capabilities[cap];
      if (!o.model && !o.voice) delete vblock.capabilities[cap];
    }
    if (!Object.keys(vblock.capabilities).length) delete vblock.capabilities;

    // 供应商聚合卡片同时把对应能力切换为当前活动供应商：仅对已在登记表标记为
    // live 的能力生效，避免切到尚未实现的适配器（如 planned 的 TTS / 数字人）。
    const appOverrides = {};
    const v = (vendors || []).find(x => x.vendor_id === vid);
    if (v && v.capabilities) {
      for (const c of v.capabilities) {
        if (c.status !== 'live') continue;
        if (c.capability === 'llm' && vblock.capabilities && vblock.capabilities.llm) {
          appOverrides.llm_provider = vid;
        }
        if (c.capability === 'tts' && vblock.capabilities && vblock.capabilities.tts) {
          appOverrides.tts_server = c.target;
        }
      }
    }
    const body = { vendors: { [vid]: vblock } };
    if (Object.keys(appOverrides).length) body.app = appOverrides;

    try {
      await api('POST', '/config', body);
      toast('供应商配置已保存' + (Object.keys(appOverrides).length ? '，已切换活动供应商' : ''));
      this.loadVendors();
    } catch (e) { toast(e.message, true); }
  },
  async save() {
    const inputs = document.querySelectorAll('#view input[data-sec]');
    const out = {};
    inputs.forEach(inp => {
      const sec = inp.dataset.sec, key = inp.dataset.key;
      let v;
      if (inp.type === 'checkbox') v = inp.checked;
      else {
        v = inp.value;
        if (v === 'true') v = true; else if (v === 'false') v = false;
        else if (v !== '' && /^-?\\d+(\\.\\d+)?$/.test(v)) v = Number(v);
      }
      out[sec] = out[sec] || {}; out[sec][key] = v;
    });
    try { await api('POST', '/config', out); toast('配置已保存'); }
    catch (e) { toast(e.message, true); }
  },
};

/* ---------------- 顶栏：功能引导 ---------------- */
function renderTopbar() {
  const box = document.getElementById('guideBox');
  if (!box) return;
  box.innerHTML = `<button class="ver-btn" id="guideBtn" type="button">功能引导</button>`;
  const gb = document.getElementById('guideBtn');
  if (gb) gb.onclick = () => Onboarding.start();
  renderVersion();
}

/* 版本号只取本地值（项目已脱离原 GitHub，不做远程更新检查），渲染到侧边栏底部。 */
function renderVersion() {
  const box = document.getElementById('verBox');
  if (!box) return;
  box.innerHTML = `<span class="ver" id="verBadge"><span class="dot"></span><span id="verText">v…</span></span>`;
  api('GET', '/version').then(d => {
    if (!d) return;
    const t = document.getElementById('verText');
    if (t) t.textContent = 'v' + d.current_version;
  }).catch(() => { const t = document.getElementById('verText'); if (t) t.textContent = 'v?'; });
}

/* ---------------- Onboarding 功能引导 tour ---------------- */
const Onboarding = {
  KEY: 'ttq_onboarded',
  steps: NAV.map(n => ({
    id: n.id,
    label: n.label,
    desc: {
      generate: '填主题或粘贴口播稿即可一键出片，支持字幕/配音/配乐等高级选项。',
      chars: '管理数字人形象的「人物」：名称、口吻与数字人源图/源视频，后续生成任务可一键套用。',
      voices: '为人物克隆专属音色，选择 Provider 并上传样本音频，口播即可复用该声音。',
      reference: '粘贴文案或给对标链接/文件，自动转写并做语义级仿写，快速产出自己的口播稿。',
      compliance: '违禁词分级（阻断/提示）检测与改写建议，降低平台违规风险。',
      titlecover: '基于主题/文案一键生成吸睛标题、话题标签与封面图，支持本地或云端引擎。',
      koucopy: '口播视频的上游素材台：粘贴或 AI 生成口播文案，自动分割成段，一键生成口播工程并导入「口播视频」。',
      history: '混剪与口播任务的统一合并视图：按类型打标，支持重新生成/重试/复审/删除。',
      scheduler: '批量提交口播任务，按优先级调度，实时监控并做失败重试与人工复审。',
      settings: '大模型/配音/字幕等配置集中管理，编辑后原子落盘到 config.toml。',
    }[n.id] || '',
  })),
  _i: 0,
  maybeStart() {
    try { if (!localStorage.getItem(this.KEY)) this.start(); }
    catch (e) { /* localStorage 不可用时直接跳过引导 */ }
  },
  start() {
    this._i = 0;
    this.render();
  },
  render() {
    const mask = document.getElementById('obMask');
    if (!mask) return;
    const total = this.steps.length;
    const s = this.steps[this._i];
    const ico = ICONS[s.id] || '';
    const dots = Array.from({ length: total }, (_, k) => `<i class="${k === this._i ? 'on' : ''}"></i>`).join('');
    mask.innerHTML = `<div class="ob-card">
      <h2>欢迎使用 TTQ 口播智能体</h2>
      <p class="ob-sub">花 30 秒了解各模块能做什么（第 ${this._i + 1} / ${total} 步）</p>
      <div class="ob-step">
        <div class="ob-ico"><svg viewBox="0 0 1024 1024">${ico}</svg></div>
        <div><div class="ob-t">${esc(s.label)}</div><div class="ob-d">${esc(s.desc)}</div></div>
      </div>
      <div class="ob-dots">${dots}</div>
      <div class="ob-foot">
        <span class="ob-skip" id="obSkip">跳过</span>
        <div style="display:flex;gap:8px">
          ${this._i > 0 ? '<button class="btn sm ghost" id="obPrev">上一步</button>' : ''}
          <button class="btn sm" id="obNext">${this._i === total - 1 ? '开始使用' : '下一步'}</button>
        </div>
      </div>
    </div>`;
    mask.classList.remove('hidden');
    // 让引导视窗与当前讲解的模块对应，半透明遮罩下可见上下文。
    navigate(s.id);
    const next = document.getElementById('obNext');
    if (next) next.onclick = () => {
      if (this._i === total - 1) this.finish();
      else { this._i++; this.render(); }
    };
    const prev = document.getElementById('obPrev');
    if (prev) prev.onclick = () => { this._i--; this.render(); };
    const skip = document.getElementById('obSkip');
    if (skip) skip.onclick = () => this.finish();
  },
  finish() {
    try { localStorage.setItem(this.KEY, '1'); } catch (e) {}
    const mask = document.getElementById('obMask');
    if (mask) mask.classList.add('hidden');
    navigate('generate');
  },
};

/* ---------------- 启动 ---------------- */
renderNav();
renderTopbar();
navigate('generate');
Onboarding.maybeStart();
