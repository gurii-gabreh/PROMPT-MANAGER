#!/usr/bin/env node
/**
 * ============================================================
 * PROMPT MANAGER — ローカル生成サーバー
 * Claude Pro プランの claude CLI を使ってプロンプトを自動生成する。
 * index.html（ブラウザ）から直接呼び出される。
 * Googleスプレッドシートへの読み書きはこのサーバーでは行わない
 * （それは今まで通り index.html → GAS が担当する）。
 *
 * 使い方：
 *   node server.js
 *   （または start-server.command をダブルクリック）
 * 停止：
 *   アプリの「ターミナルを停止しますか？」モーダルでOKを押すと自動停止。
 *   手動で止めたい場合はターミナルで Ctrl+C。
 * ============================================================
 */
'use strict';

const http = require('http');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 5678;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

function withCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, statusCode, obj) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooLarge = false;
    req.on('data', chunk => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return reject(new Error('リクエストが大きすぎます'));
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSONの解析に失敗しました')); }
    });
    req.on('error', reject);
  });
}

// ============================================================
// claude CLI に渡すメタプロンプトを組み立てる
// ============================================================
function buildMetaPrompt({ targetAI, requirement, candidates, expertiseText, detailText, volumeText, fullStructure, feedbackHistory }) {
  let p = '';
  p += `あなたはプロのプロンプトエンジニアです。以下の依頼内容に基づき、${targetAI}向けの高品質なプロンプトを作成してください。\n\n`;
  p += `## 依頼内容\n${requirement}\n\n`;

  if (Array.isArray(feedbackHistory) && feedbackHistory.length > 0) {
    p += `## 追加の要望（プレビュー確認時にユーザーから出た要望。必ずプロンプトの内容に反映すること）\n`;
    feedbackHistory.forEach((f, i) => { p += `${i + 1}. ${f}\n`; });
    p += `\n`;
  }

  if (Array.isArray(candidates) && candidates.length > 0) {
    p += `## 参考プロンプト候補（chapro.jpより。関連度が高いものがあれば構成・スタイルの参考にし、なければ無視してよい）\n`;
    candidates.forEach(c => {
      const body = String(c.body || '').slice(0, 800);
      p += `---\nID: ${c.id}\nタイトル: ${c.title}\nカテゴリ: ${c.category}\n本文:\n${body}\n`;
    });
    p += `---\n\n`;
    p += `上記候補の中から、依頼内容に最も関連するものを1つだけ選んでください（関連するものが無ければ「none」としてください）。\n\n`;
  }

  p += `## 作成条件\n`;
  p += `- 対象AI：${targetAI}\n`;
  p += `- 言語：日本語\n`;
  p += `- ${targetAI}の特性（能力・制約・得意分野）を最大限に活かした内容にすること\n`;
  if (fullStructure) {
    p += `- 誰でも使いやすいよう、プロンプトの冒頭に使い方の簡単な説明を入れること\n`;
    p += `- プロンプト本文と使用例を含めること\n`;
  } else {
    p += `- 前置きや使い方の説明、使用例などは付けず、プロンプト本文だけをシンプルに作成すること\n`;
  }
  if (expertiseText) {
    p += `- 生成する【プロンプト本文】自体の説明・言い回しを、次の専門性レベルで書くこと：${expertiseText}\n`;
    p += `  （さらに、このプロンプトを使ってAIに回答させる際も同じ専門性レベルで答えるよう、プロンプト内に明記すること）\n`;
  }
  if (detailText) {
    p += `- このプロンプトを使ってAIに回答させる際の詳細度は次の水準にするよう、プロンプト内に明記すること：${detailText}\n`;
  }
  if (volumeText) {
    p += `- このプロンプトを使ってAIに回答させる際の分量は次の水準にするよう、プロンプト内に明記すること：${volumeText}\n`;
  }
  p += `\n`;
  p += `## 出力形式（厳守・これ以外の前置きや説明文は一切書かないこと）\n`;
  p += `1行目：「REF_USED: <選んだ候補のID、無ければnone>」とだけ書く\n`;
  p += `2行目：「REF_REASON:」とだけ書く\n`;
  p += `3行目以降：なぜその候補を選んだか（選ばなかった場合はなぜ参考プロンプト無しで作成したか）を、「- 」で始まる箇条書きで1〜3行\n`;
  p += `箇条書きの直後に「---」とだけ書く\n`;
  if (fullStructure) {
    p += `その後：以下の見出しに沿った本文\n`;
    p += `【プロンプトタイトル】\n【プロンプト本文】\n【使い方・使用例】\n【期待できる効果】\n`;
  } else {
    p += `その後：見出しを付けず、プロンプト本文のみを出力すること\n`;
  }
  return p;
}

// ============================================================
// 現在のレベル設定・要望履歴で回答した場合のサンプル（プレビュー）を作らせる
// ============================================================
function buildPreviewPrompt({ targetAI, requirement, expertiseText, detailText, volumeText, feedbackHistory }) {
  let p = '';
  p += `あなたは${targetAI}になりきって、以下の依頼に実際に回答するプレビューを作成してください。\n`;
  p += `これは本番のプロンプトではありません。「このレベル設定で生成した場合、だいたいこんな回答になる」という\n`;
  p += `確認用のサンプル回答です。\n\n`;
  p += `## 依頼内容\n${requirement}\n\n`;
  if (expertiseText) p += `## 専門性レベル\n${expertiseText}\n\n`;
  if (detailText)    p += `## 回答の詳細度\n${detailText}\n\n`;
  if (volumeText)    p += `## 出力ボリューム\n${volumeText}\n\n`;
  if (Array.isArray(feedbackHistory) && feedbackHistory.length > 0) {
    p += `## 追加の要望（必ず反映すること）\n`;
    feedbackHistory.forEach((f, i) => { p += `${i + 1}. ${f}\n`; });
    p += `\n`;
  }
  p += `## 出力\n上記の条件をすべて満たすサンプル回答のみを出力してください。前置きや説明は不要です。\n`;
  return p;
}

// ============================================================
// レベル感を判断するための質問（クリック回答式）をclaude CLIに作らせる
// ============================================================
function buildQuestionsPrompt({ targetAI, requirement }) {
  let p = '';
  p += `あなたはプロンプト設計のヒアリングを行うアシスタントです。\n`;
  p += `以下の依頼内容をもとに、${targetAI}向けプロンプトを作る上で重要な\n`;
  p += `「専門性レベル」「回答の詳細度」「出力ボリューム」を判断するための質問を、それぞれ1問ずつ、合計3問作成してください。\n`;
  p += `質問・選択肢は依頼内容に即した具体的な言葉にすること（例：読み手が誰か、何のために使うか等）。\n\n`;
  p += `## 依頼内容\n${requirement}\n\n`;
  p += `## 出力形式（厳守・これ以外の前置きや説明文は一切書かないこと）\n`;
  p += `AXIS: expertise\n`;
  p += `QUESTION: <質問文>\n`;
  p += `OPTION: <選択肢文> | LEVEL:1\n`;
  p += `OPTION: <選択肢文> | LEVEL:3\n`;
  p += `OPTION: <選択肢文> | LEVEL:5\n`;
  p += `---\n`;
  p += `AXIS: detail\n`;
  p += `QUESTION: <質問文>\n`;
  p += `OPTION: <選択肢文> | LEVEL:1\n`;
  p += `OPTION: <選択肢文> | LEVEL:3\n`;
  p += `OPTION: <選択肢文> | LEVEL:5\n`;
  p += `---\n`;
  p += `AXIS: volume\n`;
  p += `QUESTION: <質問文>\n`;
  p += `OPTION: <選択肢文> | LEVEL:1\n`;
  p += `OPTION: <選択肢文> | LEVEL:3\n`;
  p += `OPTION: <選択肢文> | LEVEL:5\n`;
  p += `---\n`;
  p += `LEVEL:1は「やさしく／ざっくり／短め」、LEVEL:3は「標準」、LEVEL:5は「専門的／精密／長め」に対応する\n`;
  p += `（axisがvolumeの場合のLEVELは出力の分量の長さを表す）。\n`;
  return p;
}

function parseQuestions(raw) {
  const blocks = raw.replace(/\r\n/g, '\n').split(/\n---\s*\n?/).map(b => b.trim()).filter(Boolean);
  const questions = [];

  blocks.forEach(block => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    let axis = null;
    let question = null;
    const options = [];

    lines.forEach(line => {
      if (/^AXIS:/i.test(line)) {
        axis = line.split(':').slice(1).join(':').trim();
      } else if (/^QUESTION:/i.test(line)) {
        question = line.split(':').slice(1).join(':').trim();
      } else if (/^OPTION:/i.test(line)) {
        const m = line.match(/^OPTION:\s*(.+?)\s*\|\s*LEVEL:\s*(\d)/i);
        if (m) options.push({ text: m[1].trim(), level: parseInt(m[2], 10) });
      }
    });

    if (axis && question && options.length > 0) {
      questions.push({ axis, question, options });
    }
  });

  return questions;
}

// ============================================================
// claude CLI をヘッドレス実行（stdin経由でプロンプトを渡す）
// ============================================================
const CLAUDE_TIMEOUT_MS = 3 * 60 * 1000; // 3分でタイムアウト（ハングアップ防止）

function runClaude(promptText) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('claude の応答がタイムアウトしました（3分経過）'));
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('claude コマンドを起動できませんでした（PATHが通っているか確認してください）: ' + err.message));
    });

    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `claude がエラー終了しました (code ${code})`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.write(promptText);
    child.stdin.end();
  });
}

function parseClaudeOutput(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let refUsed = null;
  let refReasons = [];
  let idx = 0;

  if (lines[idx] && lines[idx].trim().toUpperCase().startsWith('REF_USED:')) {
    const val = lines[idx].split(':').slice(1).join(':').trim();
    refUsed = (val && val.toLowerCase() !== 'none' && val !== 'なし') ? val : null;
    idx++;

    if (lines[idx] && lines[idx].trim().toUpperCase().startsWith('REF_REASON:')) {
      idx++;
      while (lines[idx] && lines[idx].trim().startsWith('-')) {
        refReasons.push(lines[idx].trim().replace(/^-\s*/, ''));
        idx++;
      }
    }

    if (lines[idx] && lines[idx].trim() === '---') idx++;
  }

  return { refUsed, refReasons, generated: lines.slice(idx).join('\n').trim() };
}

// ============================================================
// HTTPサーバー
// ============================================================
const server = http.createServer(async (req, res) => {
  withCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { status: 'ok' });
  }

  if (req.method === 'POST' && req.url === '/generate') {
    try {
      const body = await readJsonBody(req);
      if (!body.targetAI || !body.requirement) {
        return sendJson(res, 400, { status: 'error', message: 'targetAI / requirement は必須です' });
      }
      const promptText = buildMetaPrompt(body);
      const raw = await runClaude(promptText);
      const { refUsed, refReasons, generated } = parseClaudeOutput(raw);
      const matched = Array.isArray(body.candidates)
        ? body.candidates.find(c => String(c.id) === String(refUsed))
        : null;
      return sendJson(res, 200, {
        status: 'ok',
        generated,
        refUsed,
        refUsedTitle: matched ? matched.title : null,
        refReasons
      });
    } catch (e) {
      return sendJson(res, 500, { status: 'error', message: String(e && e.message || e) });
    }
  }

  if (req.method === 'POST' && req.url === '/questions') {
    try {
      const body = await readJsonBody(req);
      if (!body.targetAI || !body.requirement) {
        return sendJson(res, 400, { status: 'error', message: 'targetAI / requirement は必須です' });
      }
      const promptText = buildQuestionsPrompt(body);
      const raw = await runClaude(promptText);
      const questions = parseQuestions(raw);
      return sendJson(res, 200, { status: 'ok', questions });
    } catch (e) {
      return sendJson(res, 500, { status: 'error', message: String(e && e.message || e) });
    }
  }

  if (req.method === 'POST' && req.url === '/preview') {
    try {
      const body = await readJsonBody(req);
      if (!body.targetAI || !body.requirement) {
        return sendJson(res, 400, { status: 'error', message: 'targetAI / requirement は必須です' });
      }
      const promptText = buildPreviewPrompt(body);
      const raw = await runClaude(promptText);
      return sendJson(res, 200, { status: 'ok', preview: raw.trim() });
    } catch (e) {
      return sendJson(res, 500, { status: 'error', message: String(e && e.message || e) });
    }
  }

  if (req.method === 'POST' && req.url === '/shutdown') {
    sendJson(res, 200, { status: 'ok' });
    setTimeout(() => process.exit(0), 200);
    return;
  }

  sendJson(res, 404, { status: 'error', message: 'not found' });
});

server.listen(PORT, () => {
  console.log('============================================================');
  console.log(`PROMPT MANAGER ローカル生成サーバーを起動しました`);
  console.log(`  http://localhost:${PORT}`);
  console.log('このターミナルは開いたままにしてください。');
  console.log('アプリ側で生成完了後に「停止しますか？」でOKを押すと自動終了します。');
  console.log('手動で止める場合は Ctrl+C を押してください。');
  console.log('============================================================');
});
