#!/usr/bin/env node
/**
 * OCS DeepSeek 本地题库
 * ------------------------------------------------------------
 * 一个零依赖的本地 HTTP 服务：
 *   - 接收 OCS 脚本发来的题目（题干 / 选项 / 题型）
 *   - 先查本地题库（data/bank.json），命中直接返回，不花钱不耗时
 *   - 未命中时调用 DeepSeek 生成答案，并自动写回本地题库
 *   - 附带一个网页管理台（http://127.0.0.1:8787），可以填 Key、测题、管理题库
 *
 * 启动：node server.mjs   （或双击 启动题库.cmd）
 */

import { exec } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatAnswer, parseModelOutput, typeLabel } from './lib/answer.mjs';
import { Bank } from './lib/bank.mjs';
import { loadConfig, maskKey, publicConfig, updateConfig } from './lib/config.mjs';
import { DeepSeekClient } from './lib/deepseek.mjs';
import {
	countOptionLetters,
	looksLikeImageQuestion,
	matchOption,
	needsManualWork,
	normalizeText,
	normalizeType,
	parseOptions,
	questionKey,
	pickTextBoxPart,
	splitSubQuestions,
	stripQuestionNoise,
	truncate
} from './lib/text.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// 数据目录可通过环境变量 OCS_TIKU_DATA_DIR 覆盖（自检测试用它避免污染真实题库）
const DATA_DIR = process.env.OCS_TIKU_DATA_DIR
	? path.resolve(process.env.OCS_TIKU_DATA_DIR)
	: path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const VERSION = '1.1.8';

const STARTED_AT = Date.now();

let config = loadConfig(ROOT);
const bank = new Bank(DATA_DIR).init();
if (config.htmlAnswer !== false) {
	const dropped = bank.pruneLegacyTextAnswers();
	if (dropped) console.log(`🧹 已清理 ${dropped} 条没有换行的旧简答缓存，下次遇到会重新生成`);
}
const client = new DeepSeekClient(() => config);

/** 同一道题并发查询时只调一次 DeepSeek */
const inflight = new Map();
/** 最近的调用记录，给管理台实时显示 */
const recentCalls = [];
const MAX_RECENT = 300;
/** 访问日志：排查「OCS 到底有没有把请求发过来」用 */
const recentAccess = [];
const MAX_ACCESS = 200;

class HttpError extends Error {
	constructor(status, message, extra = {}) {
		super(message);
		this.status = status;
		this.extra = extra;
	}
}

// ---------------------------------------------------------------- 日志

function ensureLogDir() {
	if (!config.logRetentionDays) return;
	try {
		fs.mkdirSync(LOG_DIR, { recursive: true });
	} catch {}
}

function cleanupLogs() {
	if (!config.logRetentionDays) return;
	try {
		const limit = Date.now() - config.logRetentionDays * 86400000;
		for (const name of fs.readdirSync(LOG_DIR)) {
			if (!name.endsWith('.jsonl')) continue;
			const file = path.join(LOG_DIR, name);
			if (fs.statSync(file).mtimeMs < limit) fs.unlinkSync(file);
		}
	} catch {}
}

function recordCall(record) {
	recentCalls.unshift(record);
	if (recentCalls.length > MAX_RECENT) recentCalls.pop();
	if (!config.logRetentionDays) return;
	try {
		const day = new Date().toISOString().slice(0, 10);
		fs.appendFile(path.join(LOG_DIR, `${day}.jsonl`), JSON.stringify(record) + '\n', () => {});
	} catch {}
}

function recordAccess(req, res, started, pathname) {
	const entry = {
		t: new Date().toISOString(),
		method: req.method,
		path: pathname,
		status: res.statusCode,
		ms: Date.now() - started,
		origin: String(req.headers.origin || ''),
		ua: String(req.headers['user-agent'] || '').slice(0, 90)
	};
	recentAccess.unshift(entry);
	if (recentAccess.length > MAX_ACCESS) recentAccess.pop();
	if (!config.logRetentionDays) return;
	try {
		const day = new Date().toISOString().slice(0, 10);
		fs.appendFile(path.join(LOG_DIR, `access-${day}.jsonl`), JSON.stringify(entry) + '\n', () => {});
	} catch {}
}

// ---------------------------------------------------------------- 答题核心
/**
 * 把一条历史记录“翻译”成当前选项下的字母答案，交给 formatAnswer 复用格式化逻辑。
 * 返回 null 表示这条记录对当前选项不适用。
 */
function modelFromEntry(entry, options) {
	const letters = [];
	for (const picked of entry.picked || []) {
		const matched = matchOption(options, picked);
		if (matched && !letters.includes(matched.letter)) letters.push(matched.letter);
	}
	if (!letters.length && Array.isArray(entry.letters) && entry.letters.length) {
		const valid = entry.letters.filter((letter) => letter.charCodeAt(0) - 65 < options.length);
		if (valid.length === entry.letters.length) letters.push(...valid);
	}
	if (!letters.length && entry.text) {
		const matched = matchOption(options, entry.text);
		if (matched && !letters.includes(matched.letter)) letters.push(matched.letter);
	}
	const text = unwrapComposite(entry.text || (entry.type === 'completion' ? entry.answer : ''));
	if (!letters.length && !text) return null;
	return {
		kind: entry.type,
		letters: [...new Set(letters)].sort(),
		text,
		confidence: entry.confidence ?? 0,
		note: entry.note ?? '',
		parsed: true
	};
}

/**
 * 复合题答案段数的候选值。服务端看不到页面 DOM，只能轮换尝试：
 * 先用固定的常见值（9 = 4+4 个选项 + 1 个空，17 = 每个选项占两个元素，10 / 18 是空框同时
 * 命中 .textDIV 和 .eidtDiv 的情况），再退到按题干里数出来的选项字母数推算。
 * 同一道题每被问一次就换下一个；段数不匹配时 OCS 的 resolveCompletion 直接返回 false，
 * 什么都不会做，所以多试几次没有副作用。
 */
const compositeSlotAttempts = new Map();

function nextCompositeSlots(key, optionLetters) {
	const ladder = [9, 17, 10, 18, optionLetters + 1, optionLetters * 2 + 1].filter(
		(value, index, array) => value >= 2 && array.indexOf(value) === index
	);
	const attempt = compositeSlotAttempts.get(key) || 0;
	compositeSlotAttempts.set(key, (attempt + 1) % ladder.length);
	if (compositeSlotAttempts.size > 5000) compositeSlotAttempts.clear();
	return ladder[attempt % ladder.length];
}

/**
 * 把历史缓存里「已经拼成 JSON 数组」的复合题答案还原成纯文本，
 * 避免复用旧条目时再包一层数组（OCS 解析出来就是一堆 "[...]" 字符串）。
 */
function unwrapComposite(text) {
	const raw = String(text ?? '').trim();
	if (!raw.startsWith('[') || !raw.endsWith(']')) return text;
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return text;
		const meaningful = parsed.map((item) => String(item ?? '')).filter((item) => item && item !== '（略）');
		return meaningful.length ? meaningful[meaningful.length - 1] : '';
	} catch {
		return text;
	}
}

/**
 * 复合题（混排单选 + 填空）在 OCS 侧只走 completion 分支，而它要求
 * 「答案段数 === 页面元素数」才会填任何东西。这里把答案拼成 JSON 数组：
 * 前 N 段是选项占位（completion 分支对选项元素不做任何事），最后一段才是文字答案。
 */
function wrapCompositeAnswer(slots, text) {
	if (!slots || slots < 2 || !text) return text;
	const pieces = [];
	for (let i = 0; i < slots - 1; i++) pieces.push('（略）');
	pieces.push(text);
	return JSON.stringify(pieces);
}

/** 尝试用历史记录直接回答当前题目 */
function reuseEntry(entry, options, type, compositeSlots = 0) {
	if (!entry) return null;
	if ((entry.options?.length || 0) !== options.length && options.length) {
		// 选项数量变了：只有在旧答案是“文本类”（而非依赖选项顺序）时才允许复用
		if (!entry.picked?.length && entry.type !== type) return null;
	}
	const model = modelFromEntry(entry, options);
	if (!model) return null;
	const formatted = formatAnswer({ type, options, model, html: config.htmlAnswer !== false && !compositeSlots });
	if (!formatted.answer) return null;
	formatted.answer = wrapCompositeAnswer(compositeSlots, formatted.answer);
	return formatted;
}

/**
 * 复合题的答案会按「(1) C / (2) A / (3) 代码」的顺序排下来，而页面上的文字框只需要最后那一问。
 * 这里按 <br> 找最后一个「(n)」标记行，取它后面的内容作为要写进框里的文字。
 * 判断是标记行而不是代码里的括号：去掉标记后剩下的内容很短（≤ 24 字），`for (i = 1; …)` 这类不会命中。
 */
function extractLastPart(html) {
	const lines = String(html ?? '').split(/<br\s*\/?>/i);
	let index = -1;
	let inline = '';
	for (let i = 0; i < lines.length; i++) {
		const plain = lines[i].replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').trim();
		const marker = plain.match(/^[（(]\s*(\d{1,2})\s*[)）]/);
		if (!marker) continue;
		const rest = plain.slice(marker[0].length).trim();
		if (rest.length <= 24) {
			index = i;
			inline = rest;
		}
	}
	if (index < 0) return '';
	const tail = lines
		.slice(index + 1)
		.join('<br>')
		.replace(/^(<br>)+/i, '')
		.trim();
	// 标记行后面还有内容（代码/说明）就用后面的；否则用标记行自己的那句（例如「(4) 上面说法都不对」）
	return tail || inline;
}

function buildResponse({ title, type, formatted, source, model, cached, ms, mock, focusPart = null, subQuestionCount = 0, slots = 0 }) {
	// box：真正要写进文本框的那部分（复合题只取最后一问，前面几问的字母留着让用户自己点选项）
	const box = subQuestionCount >= 2 ? extractLastPart(formatted.answer) || formatted.answer : formatted.answer;
	return {
		code: 1,
		msg: cached ? '命中本地题库' : 'DeepSeek 生成',
		question: title,
		answer: formatted.answer,
		box,
		type,
		typeLabel: typeLabel(type),
		letters: formatted.letters,
		picked: formatted.picked,
		mode: formatted.mode,
		verdict: formatted.verdict,
		confidence: formatted.confidence ?? model?.confidence ?? 0,
		note: formatted.note ?? model?.note ?? '',
		source,
		cached: Boolean(cached),
		model: model?.model ?? '',
		mock: Boolean(mock),
		focusPart,
		subQuestionCount,
		slots,
		ms
	};
}

/** 题干上限：超星复合题的题干能到上万字符（含所有小问和选项文本） */
const MAX_TITLE_LENGTH = 20000;

/**
 * 题干清洗：
 * - 超星会把 UEditor 的初始化脚本整段塞进标题里（`$(function(){…UE.getEditor…})`），砍掉；
 * - 把一堆制表符/全角空格压成单个空格，避免白白撑爆长度限制。
 */
function sanitizeTitle(input) {
	let text = String(input ?? '').replace(/\r\n?/g, '\n');
	const scriptAt = text.search(/\$\(function\s*\(|window\.UEDITOR_CONFIG|UE\.getEditor\s*\(|var\s+editor\d*\s*=/);
	if (scriptAt > 0) text = text.slice(0, scriptAt);
	text = text.replace(/[\t\u00a0\u3000]+/g, ' ').replace(/ {2,}/g, ' ');
	return text.replace(/\n{3,}/g, '\n\n').trim();
}
async function computeWithDeepSeek({ title, type, options, rawType, hint, key, wholeQuestion = false, compositeSlots = 0 }) {
	bank.counters.aiCalls++;
	let result;
	try {
		result = await client.ask({ title, type, options, hint, wholeQuestion });
	} catch (error) {
		bank.counters.aiFailures++;
		throw error;
	}

	const model = parseModelOutput(result.content);
	const formatted = formatAnswer({ type, options, model, html: config.htmlAnswer !== false && !compositeSlots });
	formatted.answer = wrapCompositeAnswer(compositeSlots, formatted.answer);

	if (!formatted.answer) {
		if (formatted.kind === 'skip' || formatted.mode === 'skip') {
			// 模型自己判断这题要看图 / 交截图，直接留空，不当成错误重试
			throw new HttpError(200, formatted.warning || '该题需要看图或提交截图，已留空');
		}
		const reason = formatted.warning || model.note || '模型没有给出可用答案';
		throw new HttpError(502, `未能得到答案：${reason}`);
	}

	bank.upsert({
		key,
		title,
		titleNorm: normalizeText(stripQuestionNoise(title)),
		type,
		typeRaw: rawType,
		options: options.map((option) => option.raw),
		optionCount: options.length,
		letters: formatted.letters,
		picked: formatted.picked,
		answer: formatted.answer,
		text: model.text,
		mode: formatted.mode,
		verdict: formatted.verdict,
		confidence: model.confidence,
		note: model.note,
		source: 'ai',
		model: result.model,
		usage: result.usage
	});

	return { formatted, model: result.model, usage: result.usage, mock: result.mock };
}

/**
 * 一些题不该答：主观题要交截图、或主观题必须看图。
 * 只对「主观题（填空/简答/问答）」生效 —— 选择题、判断题即使题干里提到截图/图片也要正常作答，
 * 否则会出现「一个大题下面几个小题全被跳过」的情况。
 * 返回留空的原因，返回空串表示正常作答。
 */
function precheckSkip(titleText, type) {
	const subjective = type === 'completion' || type === 'unknown';
	if (!subjective) return '';
	if (config.skipManualWork === true && needsManualWork(titleText)) {
		return '该题要求交截图/图片，文字交不了，已按要求留空';
	}
	if (config.skipImageQuestions === true && looksLikeImageQuestion(titleText)) {
		return '该题含图片且没有文字作答条件，模型看不到图，已跳过（可在管理台设置里关闭）';
	}
	return '';
}

/**
 * 主流程：跳过 → 缓存 → 同题复用 → DeepSeek（并发合并）
 */
async function answerQuestion({ title, options: rawOptions, type: rawType, hint }) {
	const started = Date.now();
	const titleText = sanitizeTitle(String(title ?? ''));
	if (!titleText) throw new HttpError(400, '缺少题目内容（title 为空）');
	if (titleText.length > MAX_TITLE_LENGTH) {
		throw new HttpError(400, '题目过长（超过 ' + MAX_TITLE_LENGTH + ' 字）');
	}

	let type = normalizeType(rawType);
	const options = parseOptions(rawOptions);

	// 没有选项又没题型标记的，基本就是填空/简答：先归到 completion，
	// 免得同一道题被 OCS 用 unknown / completion 两种标记各调一次模型（还会缓存两份）。
	if (type === 'unknown' && options.length === 0) type = 'completion';

	// 复合题（一道大题下含 (1)(2)(3) 多个小问）：OCS 把整道题当一道题送过来，
	// 且只用 completion 的方式往那个文字框里写一次。这里不再拆小问、也不再拼段数，
	// 直接让模型按题目顺序把小问逐个答出来（见 buildMessages 的 wholeQuestion）。
	// 注意：只有「没有选项」的主观题才算复合题。带选项的题必须按选项作答，
	// 否则 OCS 会把这段文字拼进 span.saveSingleSelect[data="…"] 选择器，直接抛
	// Failed to execute 'querySelector' on 'Element'。
	const subQuestions =
		options.length === 0 && (type === 'completion' || type === 'unknown') ? splitSubQuestions(titleText) : [];
	const wholeQuestion = subQuestions.length >= 2;
	const compositeSlots = 0;

	const key = questionKey(titleText, type);

	bank.counters.lookups++;

	// 1) 完全命中
	const exact = bank.get(key);
	if (exact) {
		const formatted = reuseEntry(exact, options, type, compositeSlots);
		if (formatted) {
			bank.counters.hits++;
			bank.touch(exact, formatted.answer, { picked: formatted.picked, letters: formatted.letters });
			bank.flush();
			return buildResponse({
				title: titleText,
				type,
				formatted,
				source: 'cache',
				model: { model: exact.model, confidence: exact.confidence, note: exact.note },
				cached: true,
				focusPart: null,
			slots: compositeSlots,
				subQuestionCount: subQuestions.length,
				ms: Date.now() - started
			});
		}
	}

	// 2) 同一题干、不同题型标记（例如单选/多选混用）的复用
	if (options.length) {
		const candidates = bank.candidates(normalizeText(stripQuestionNoise(titleText)), type);
		for (const entry of candidates) {
			if (entry === exact) continue;
			const formatted = reuseEntry(entry, options, type, compositeSlots);
			if (formatted) {
				bank.counters.hits++;
				bank.upsert({
					key,
					title: titleText,
					titleNorm: normalizeText(stripQuestionNoise(titleText)),
					type,
					typeRaw: rawType,
					options: options.map((option) => option.raw),
					optionCount: options.length,
					letters: formatted.letters,
					picked: formatted.picked,
					answer: formatted.answer,
					text: entry.text,
					mode: formatted.mode,
					verdict: formatted.verdict,
					confidence: entry.confidence,
					note: entry.note,
					source: 'cache',
					model: entry.model
				});
				return buildResponse({
					title: titleText,
					type,
					formatted,
					source: 'cache',
					model: { model: entry.model, confidence: entry.confidence, note: entry.note },
					cached: true,
					focusPart: null,
			slots: compositeSlots,
					subQuestionCount: subQuestions.length,
					ms: Date.now() - started
				});
			}
		}
	}

	// 3) 主观题且必须交截图 / 必须看图的：直接留空，不花额度、不写题库
	const skipReason = precheckSkip(titleText, type);
	if (skipReason) {
		return {
			code: 0,
			msg: skipReason,
			question: titleText,
			answer: '',
			type,
			typeLabel: typeLabel(type),
			letters: [],
			picked: [],
			mode: 'skip',
			source: 'skipped',
			cached: false,
			skipped: true,
			focusPart: null,
			slots: compositeSlots,
			subQuestionCount: subQuestions.length,
			ms: Date.now() - started
		};
	}
	// 3) 调用 DeepSeek（同题并发合并）
	bank.counters.misses++;
	const existing = inflight.get(key);
	const pending =
		existing ||
		computeWithDeepSeek({ title: titleText, type, options, rawType, hint, key, wholeQuestion, compositeSlots }).finally(() => {
			inflight.delete(key);
		});
	if (!existing) inflight.set(key, pending);

	const result = await pending;
	return buildResponse({
		title: titleText,
		type,
		formatted: result.formatted,
		source: 'deepseek',
		model: { model: result.model, confidence: result.formatted.confidence, note: result.formatted.note },
		cached: false,
		focusPart: null,
		subQuestionCount: subQuestions.length,
		slots: compositeSlots,
		ms: Date.now() - started,
		mock: result.mock
	});
}

// ---------------------------------------------------------------- HTTP 工具

function corsHeaders() {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, HEAD, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tiku-Token, X-Requested-With',
		'Access-Control-Allow-Private-Network': 'true',
		'Access-Control-Max-Age': '86400',
		'Access-Control-Expose-Headers': 'Content-Disposition, X-Tiku-Elapsed'
	};
}

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		...corsHeaders(),
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(body),
		'Cache-Control': 'no-store'
	});
	res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
	res.writeHead(status, { ...corsHeaders(), 'Content-Type': contentType });
	res.end(text);
}

function readBody(req, limit = 2 * 1024 * 1024) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new HttpError(413, '请求体过大'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8');
			if (!raw.trim()) return resolve({});
			const contentType = String(req.headers['content-type'] || '');
			if (contentType.includes('application/x-www-form-urlencoded')) {
				return resolve(Object.fromEntries(new URLSearchParams(raw)));
			}
			try {
				resolve(JSON.parse(raw));
			} catch {
				reject(new HttpError(400, '请求体不是合法的 JSON'));
			}
		});
		req.on('error', reject);
	});
}

function pickBodyValue(body, keys) {
	for (const key of keys) {
		if (body[key] !== undefined && body[key] !== null && body[key] !== '') return body[key];
	}
	return '';
}

// ---------------------------------------------------------------- 静态文件

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2'
};

function serveStatic(req, res, pathname) {
	const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
	const file = path.resolve(PUBLIC_DIR, relative);
	if (!file.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');
	if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
	const ext = path.extname(file).toLowerCase();
	const body = fs.readFileSync(file);
	res.writeHead(200, {
		...corsHeaders(),
		'Content-Type': MIME[ext] || 'application/octet-stream',
		'Content-Length': body.length,
		'Cache-Control': 'no-cache'
	});
	res.end(req.method === 'HEAD' ? undefined : body);
	return true;
}

// ---------------------------------------------------------------- 路由

async function handle(req, res) {
	const host = req.headers.host || `127.0.0.1:${config.port}`;
	const url = new URL(req.url || '/', `http://${host}`);
	const pathname = decodeURIComponent(url.pathname);
	const method = req.method || 'GET';

	if (method === 'OPTIONS') {
		res.writeHead(204, corsHeaders());
		return res.end();
	}

	// 令牌保护（可选）
	if (pathname.startsWith('/api/') && config.token) {
		const header = String(req.headers['x-tiku-token'] || url.searchParams.get('token') || '');
		if (header !== config.token) throw new HttpError(401, '访问令牌不正确');
	}

	// ---- 健康检查 / 延迟探测（OCS 会先发 HEAD 探测题库延迟）
	if (pathname === '/health' || pathname === '/api/health') {
		if (method === 'HEAD') {
			res.writeHead(200, { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8' });
			return res.end();
		}
		return sendJson(res, 200, {
			ok: true,
			name: 'OCS DeepSeek 本地题库',
			version: VERSION,
			uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
			port: config.port,
			model: config.model,
			mock: Boolean(config.mock),
			hasApiKey: Boolean(config.apiKey),
			bankSize: bank.entries.length
		});
	}

	// ---- 答题接口
	if (pathname === '/api/answer' || pathname === '/answer' || pathname === '/search') {
		if (method === 'HEAD') {
			res.writeHead(200, corsHeaders());
			return res.end();
		}
		const started = Date.now();
		const body = method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
		const title = pickBodyValue(body, ['title', 'question', 'q', 'wenda']);
		const options = pickBodyValue(body, ['options', 'option', 'choices']);
		const type = pickBodyValue(body, ['type', 'question_type', 'kind']);
		const hint = pickBodyValue(body, ['hint', 'extra']);
		try {
			const result = await answerQuestion({ title, options, type, hint });
			res.setHeader('X-Tiku-Elapsed', String(Date.now() - started));
			recordCall({
				ts: new Date().toISOString(),
				type: result.type,
				title: truncate(result.question, 400),
				answer: truncate(result.answer, 400),
				slots: result.slots ?? null,
				source: result.source,
				ms: Date.now() - started,
				model: result.model
			});
			return sendJson(res, 200, result);
		} catch (error) {
			recordCall({
				ts: new Date().toISOString(),
				type: normalizeType(type),
				title: truncate(title, 400),
				answer: '',
				source: 'error',
				ms: Date.now() - started,
				error: truncate(error.message, 200)
			});
			return sendJson(res, 200, {
				code: 0,
				msg: error.message,
				question: String(title ?? ''),
				answer: '',
				type: normalizeType(type),
				ms: Date.now() - started
			});
		}
	}

	// 关闭服务：给「重新启动以加载新配置 / 新代码」用，只允许本机调用
	if (pathname === '/api/shutdown' && (method === 'POST' || method === 'GET')) {
		const remote = String(req.socket?.remoteAddress || '');
		if (!/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(remote)) {
			throw new HttpError(403, '只能从本机关闭服务');
		}
		sendJson(res, 200, { code: 1, msg: '服务正在退出' });
		setTimeout(() => {
			bank.flush();
			if (runningServer) runningServer.close();
			process.exit(0);
		}, 120);
		return;
	}

	// ---- 题库管理
	if (pathname === '/api/bank' && method === 'GET') {
		return sendJson(res, 200, {
			code: 1,
			...bank.list({
				q: url.searchParams.get('q') || '',
				type: url.searchParams.get('type') || '',
				page: url.searchParams.get('page') || 1,
				size: url.searchParams.get('size') || 20,
				sort: url.searchParams.get('sort') || 'updated'
			})
		});
	}

	if ((pathname === '/api/bank' || pathname === '/api/bank/add') && method === 'POST') {
		const body = await readBody(req);
		if (String(body.all) === 'true' || String(body.clear) === 'true') {
			const count = bank.clear();
			bank.flush();
			return sendJson(res, 200, { code: 1, msg: `已清空 ${count} 条记录`, count });
		}
		const title = String(pickBodyValue(body, ['title', 'question']) ?? '').trim();
		const type = normalizeType(pickBodyValue(body, ['type', 'question_type']));
		const answer = String(pickBodyValue(body, ['answer']) ?? '').trim();
		if (!title) throw new HttpError(400, '题目不能为空');
		if (!answer) throw new HttpError(400, '答案不能为空');
		const options = parseOptions(pickBodyValue(body, ['options', 'option']));
		const key = questionKey(title, type);
		const matched = options.length ? matchOption(options, answer) : undefined;
		const entry = bank.upsert({
			key,
			title,
			titleNorm: normalizeText(stripQuestionNoise(title)),
			type,
			typeRaw: pickBodyValue(body, ['type']),
			options: options.map((option) => option.raw),
			optionCount: options.length,
			letters: matched ? [matched.letter] : [],
			picked: matched ? [matched.raw] : [],
			answer: matched ? matched.raw : answer,
			text: options.length ? '' : answer,
			mode: matched ? 'option' : 'text',
			confidence: 1,
			note: '手工录入',
			source: 'manual',
			model: 'manual'
		});
		bank.flush();
		return sendJson(res, 200, { code: 1, msg: '已保存', entry });
	}

	if (pathname === '/api/bank' && method === 'DELETE') {
		const body = Object.fromEntries(url.searchParams);
		if (String(body.all) === 'true' || String(body.clear) === 'true') {
			const count = bank.clear();
			bank.flush();
			return sendJson(res, 200, { code: 1, msg: `已清空 ${count} 条记录`, count });
		}
		throw new HttpError(400, '缺少 id，若确认清空请传 all=true');
	}

	if (pathname.startsWith('/api/bank/') && (method === 'DELETE' || method === 'POST')) {
		const id = pathname.slice('/api/bank/'.length);
		const removed = bank.remove(id);
		bank.flush();
		return sendJson(res, 200, { code: removed ? 1 : 0, msg: removed ? '已删除' : '未找到该记录' });
	}

	if (pathname === '/api/import' && method === 'POST') {
		const body = await readBody(req);
		const payload = body.entries ?? body.data ?? body;
		const mode = body.mode === 'replace' ? 'replace' : 'merge';
		const result = bank.importEntries(payload, mode);
		bank.flush();
		return sendJson(res, 200, { code: 1, msg: `导入完成：新增 ${result.added}，更新 ${result.updated}`, ...result });
	}

	if (pathname === '/api/export' && method === 'GET') {
		const format = (url.searchParams.get('format') || 'json').toLowerCase();
		const stamp = new Date().toISOString().slice(0, 10);
		if (format === 'csv') {
			const csv = bank.toCSV();
			res.writeHead(200, {
				...corsHeaders(),
				'Content-Type': 'text/csv; charset=utf-8',
				'Content-Disposition': `attachment; filename="ocs-tiku-${stamp}.csv"`
			});
			return res.end(csv);
		}
		const json = JSON.stringify(bank.exportEntries(), null, '\t');
		res.writeHead(200, {
			...corsHeaders(),
			'Content-Type': 'application/json; charset=utf-8',
			'Content-Disposition': `attachment; filename="ocs-tiku-${stamp}.json"`
		});
		return res.end(json);
	}

	if (pathname === '/api/stats' && method === 'GET') {
		return sendJson(res, 200, { code: 1, ...bank.stats(), entries: bank.entries.length });
	}

	if (pathname === '/api/logs' && method === 'GET') {
		const limit = Math.max(1, Math.min(MAX_RECENT, Number(url.searchParams.get('limit')) || 50));
		return sendJson(res, 200, { code: 1, items: recentCalls.slice(0, limit) });
	}

	// 连通性探针：给「OCS 里到底能不能连上本地服务」用，不碰 AI、不写题库
	if (pathname === '/api/ping') {
		return sendJson(res, 200, { code: 1, ok: true, ts: Date.now(), version: VERSION, msg: '本地题库在线' });
	}

	// 访问日志（含预检 OPTIONS），用来确认请求有没有到
	if (pathname === '/api/access' && method === 'GET') {
		const limit = Math.max(1, Math.min(MAX_ACCESS, Number(url.searchParams.get('limit')) || 50));
		return sendJson(res, 200, { code: 1, items: recentAccess.slice(0, limit) });
	}

	if (pathname === '/api/config' && method === 'GET') {
		return sendJson(res, 200, {
			code: 1,
			config: publicConfig(config),
			activeModel: client.activeModel,
			lastError: client.lastError,
			mock: Boolean(config.mock)
		});
	}

	if (pathname === '/api/config' && method === 'POST') {
		const body = await readBody(req);
		const patch = {};
		if (body.apiKey !== undefined) patch.apiKey = String(body.apiKey).trim();
		if (body.model !== undefined) patch.model = String(body.model).trim();
		if (body.baseUrl !== undefined) patch.baseUrl = String(body.baseUrl).trim();
		if (body.thinking !== undefined) patch.thinking = body.thinking;
		if (body.temperature !== undefined) patch.temperature = body.temperature;
		if (body.maxTokens !== undefined) patch.maxTokens = body.maxTokens;
		if (body.timeoutSeconds !== undefined) patch.timeoutSeconds = body.timeoutSeconds;
		if (body.concurrency !== undefined) patch.concurrency = body.concurrency;
		if (body.skipManualWork !== undefined) patch.skipManualWork = body.skipManualWork === true;
		if (body.skipImageQuestions !== undefined) patch.skipImageQuestions = body.skipImageQuestions === true;
		if (body.htmlAnswer !== undefined) patch.htmlAnswer = body.htmlAnswer !== false;
		if (body.codeLanguage !== undefined) patch.codeLanguage = String(body.codeLanguage);
		if (body.fallbackModels !== undefined) {
			patch.fallbackModels = Array.isArray(body.fallbackModels)
				? body.fallbackModels
				: String(body.fallbackModels)
						.split(/[,，\s]+/)
						.filter(Boolean);
		}
		config = updateConfig(ROOT, config, patch);
		client.activeModel = '';
		return sendJson(res, 200, {
			code: 1,
			msg: '配置已保存',
			config: publicConfig(config),
			note: patch.port !== undefined ? '端口修改需要重启服务生效' : undefined
		});
	}

	if (pathname === '/api/config/test' && method === 'POST') {
		if (!config.apiKey && !config.mock) throw new HttpError(400, '请先填写并保存 API Key');
		const result = {};
		try {
			const models = await client.listModels();
			result.models = models.models;
			result.modelsMs = models.ms;
		} catch (error) {
			result.modelsError = error.message;
		}
		try {
			const test = await client.testConnection();
			result.ok = true;
			result.model = test.model;
			result.answer = test.answer;
			result.ms = test.ms;
			result.mock = Boolean(test.mock);
		} catch (error) {
			result.ok = false;
			result.error = error.message;
		}
		return sendJson(res, 200, { code: 1, ...result });
	}

	if (pathname === '/api/logs/clear' && method === 'POST') {
		recentCalls.length = 0;
		return sendJson(res, 200, { code: 1, msg: '已清空界面日志（磁盘日志保留）' });
	}

	// ---- 静态页面
	if (method === 'GET' || method === 'HEAD') {
		if (serveStatic(req, res, pathname)) return;
		if (!pathname.startsWith('/api/')) return sendText(res, 404, '页面不存在，题库管理台地址是 /');
	}

	throw new HttpError(404, `接口不存在：${method} ${pathname}`);
}

// ---------------------------------------------------------------- 启动

function banner() {
	const url = `http://127.0.0.1:${config.port}`;
	const lines = [
		'',
		'  ╔══════════════════════════════════════════════════════╗',
		'  ║           OCS DeepSeek 本地题库  v' + VERSION + '             ║',
		'  ╚══════════════════════════════════════════════════════╝',
		'',
		`  题库管理台：${url}`,
		`  答题接口　：${url}/api/answer`,
		`  监听地址　：http://${config.host}:${config.port}`,
		`  当前模型　：${config.model}${config.mock ? '（mock 模拟模式，不调用 API）' : ''}`,
		`  API Key　 ：${config.apiKey ? maskKey(config.apiKey) : '未配置（打开管理台填写）'}`,
		`  题库文件　：${path.join(DATA_DIR, 'bank.json')}（已有 ${bank.entries.length} 条）`,
		'',
		'  OCS 端：把 OCS题库配置.json 的内容粘贴到 通用-全局设置-题库配置',
		'  按 Ctrl+C 停止服务',
		''
	];
	console.log(lines.join('\n'));
}

function openBrowser(url) {
	if (process.env.OCS_TIKU_NO_OPEN || process.env.OCS_TIKU_QUIET) return;
	const cmd =
		process.platform === 'win32'
			? `start "" "${url}"`
			: process.platform === 'darwin'
				? `open "${url}"`
				: `xdg-open "${url}"`;
	exec(cmd, { windowsHide: true }, () => {});
}

/** 最近一次创建的服务实例，/api/shutdown 需要它来关闭监听 */
let runningServer = null;

/**
 * 端口被占用时，先试着让旧实例自己退出（旧版本没有这个接口就会失败），
 * 这样「更新代码后直接重新双击 cmd」也能生效，不用手动找黑窗口。
 */
async function askOldInstanceToQuit() {
	try {
		const response = await fetch(`http://127.0.0.1:${config.port}/api/shutdown`, {
			method: 'POST',
			signal: AbortSignal.timeout(1500)
		});
		if (!response.ok) return false;
		await new Promise((resolve) => setTimeout(resolve, 700));
		return true;
	} catch {
		return false;
	}
}

function start(attempt = 0) {
	ensureLogDir();
	cleanupLogs();

	const server = http.createServer((req, res) => {
		const started = Date.now();
		res.on('finish', () => recordAccess(req, res, started, String(req.url || '/').split('?')[0]));
		handle(req, res).catch((error) => {
			const status = error instanceof HttpError ? error.status : 500;
			if (status >= 500) console.error('[error]', error);
			if (res.headersSent) return res.end();
			sendJson(res, status, {
				code: 0,
				msg: error.message || '服务器内部错误',
				...((error && error.extra) || {})
			});
		});
	});
	runningServer = server;

	server.on('error', (error) => {
		if (error.code === 'EADDRINUSE') {
			const url = `http://127.0.0.1:${config.port}`;
			if (attempt === 0) {
				console.log(`  端口 ${config.port} 被一个旧实例占用，正在让它退出…`);
				askOldInstanceToQuit().then((ok) => {
					if (ok) return start(attempt + 1);
					console.log('');
					console.log(`  ⚠️  题库服务已经在运行（端口 ${config.port} 被占用），本次启动已取消。`);
					console.log('     如果刚更新过程序，双击 重启题库.cmd 就能换上新版本；');
					console.log('     或者关掉原来那个黑色命令行窗口，再双击 启动题库.cmd。');
					console.log(`     管理台：${url}`);
					console.log('');
					openBrowser(url);
					setTimeout(() => process.exit(0), 800);
				});
				return;
			}
			console.log('');
			console.log(`  ⚠️  端口 ${config.port} 仍被占用，启动失败。请关掉占用端口的窗口后重试。`);
			console.log('');
			openBrowser(url);
			setTimeout(() => process.exit(0), 800);
			return;
		}
		console.error('[server]', error);
		process.exit(1);
	});

	server.listen(config.port, config.host, () => {
		if (!process.env.OCS_TIKU_QUIET) {
			banner();
			openBrowser(`http://127.0.0.1:${config.port}/`);
		}
		// 有 Key 时后台预热一次模型列表，失败不影响使用
		if (config.apiKey && !config.mock) {
			client
				.listModels()
				.then((result) => {
					if (result.models.length) {
						console.log(`  可用模型　：${result.models.join(', ')}`);
						if (!result.models.includes(config.model)) {
							console.log(`  ⚠️  config.json 里的模型 ${config.model} 不在可用列表里，已自动尝试回退模型`);
						}
					}
				})
				.catch(() => {});
		}
	});

	const shutdown = (signal) => {
		console.log(`\n收到 ${signal}，正在保存题库并退出…`);
		bank.flush();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 1500).unref();
	};
	process.on('SIGINT', () => {
		// 后台托管模式（OCS_TIKU_DETACHED=1）下忽略控制台 Ctrl+C：
		// 这个信号常常来自启动它的终端/自动化会话结束时对整组进程的广播，不该把常驻题库带走。
		if (process.env.OCS_TIKU_DETACHED === '1') return;
		shutdown('SIGINT');
	});
	process.on('SIGBREAK', () => {
		if (process.env.OCS_TIKU_DETACHED === '1') return;
		shutdown('SIGBREAK');
	});
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('uncaughtException', (error) => console.error('[uncaught]', error));
	process.on('unhandledRejection', (error) => console.error('[unhandled]', error));
}

// 命令行参数：--port 8787 / --mock / --host 0.0.0.0
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === '--port' && argv[i + 1]) config.port = Number(argv[++i]) || config.port;
	else if (arg === '--host' && argv[i + 1]) config.host = argv[++i];
	else if (arg === '--mock') config.mock = true;
	else if (arg === '--help' || arg === '-h') {
		console.log('用法：node server.mjs [--port 8787] [--host 127.0.0.1] [--mock]');
		process.exit(0);
	} else if (arg === '--version' || arg === '-v') {
		console.log(VERSION);
		process.exit(0);
	}
}

start();

export { answerQuestion, bank, client, config };
