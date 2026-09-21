// 口播素材页 splitText 算法自测（与 resource/public/app.js VIEWS.koucopy.splitText 保持一致）
function splitText(text, target) {
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
}

function estFrames(t) {
  const n = (t || '').trim().length;
  return Math.max(60, Math.min(900, Math.round(n / 4 * 30)));
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

// 1. 常规文案：句末标点断句 + 合并到目标段长
{
  const text = '碳中和其实离我们不远。它指的是把二氧化碳的排放和吸收互相抵消。怎么做到？一是少烧化石能源，二是多种树。';
  const segs = splitText(text, 20);
  console.log(JSON.stringify(segs, null, 0));
  check('常规：有分段', segs.length >= 2);
  check('常规：内容无损', segs.join('') === text.replace(/\s/g, ''), segs.join(''));
  check('常规：段长不超标过多', segs.every(s => s.length <= 40), JSON.stringify(segs.map(s => s.length)));
}

// 2. 手动换行 = 硬边界，段与段不合并
{
  const text = '第一段开场白。\n第二段的内容，稍微长一点。\n第三段收尾。';
  const segs = splitText(text, 50);
  console.log(JSON.stringify(segs));
  check('换行：段落数', segs.length === 3, JSON.stringify(segs));
}

// 3. 超长单句：无句末标点但有逗号 → 逗号二切
{
  const text = '这是一句特别长的话没有句号但是中间有很多逗号用来分隔内容，比如这里是一个逗号，然后这里又是一个逗号，最后还有一些内容在句子的结尾部分';
  const segs = splitText(text, 20);
  console.log(JSON.stringify(segs));
  check('超长逗号：均有分段', segs.length >= 3);
  check('超长逗号：内容无损', segs.join('') === text, segs.join(''));
}

// 4. 完全无标点 → 硬长度切分（40字/目标15 → 15+15+10 三段）
{
  const text = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十';
  const segs = splitText(text, 15);
  console.log(JSON.stringify(segs));
  check('无标点：硬切', segs.length === 3 && segs.map(s => s.length).join(',') === '15,15,10', JSON.stringify(segs));
}

// 5. 空文本 / 全空白
{
  check('空文本', JSON.stringify(splitText('', 40)) === '[]');
  check('全空白', JSON.stringify(splitText('  \n \n  ', 40)) === '[]');
}

// 6. 英文/混排 + 半角标点（句间空格在分段边界丢弃，每段自身文本完整）
{
  const text = 'Hello world! This is a test. 短句。Another one?';
  const segs = splitText(text, 30);
  console.log(JSON.stringify(segs));
  check('英文：分段正确', JSON.stringify(segs) === JSON.stringify(['Hello world!', 'This is a test. 短句。', 'Another one?']), JSON.stringify(segs));
}

// 7. 单句恰好等于目标长度 → 不再切
{
  const s = '这句话正好二十个字一二三四五六七八九十';
  const segs = splitText(s, 20);
  check('恰好目标长：单段', segs.length === 1 && segs[0] === s, JSON.stringify(segs));
}

// 8. estFrames 边界
check('estFrames 短句下限2s', estFrames('你好') === 60);
check('estFrames 长句上限30s', estFrames('字'.repeat(500)) === 900);
check('estFrames 40字约10s', estFrames('字'.repeat(40)) === 300);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
