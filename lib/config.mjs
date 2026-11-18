/**
 * 配置读写。
 * 配置文件是程序目录下的 config.json（首次启动会自动生成），
 * 也支持环境变量覆盖：DEEPSEEK_API_KEY / OCS_TIKU_PORT / OCS_TIKU_MODEL。
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = {
	/** 监听端口（OCS 题库配置里的 URL 要与之一致） */
	port: 8787,
	/** 只监听回环地址，避免局域网内其他人蹭你的 API Key */
	host: '127.0.0.1',
	/** DeepSeek API Key，形如 sk-xxxxxxxx */
	apiKey: '',
	/** DeepSeek 接口地址（兼容代理/中转） */
	baseUrl: 'https://api.deepseek.com',
	/** 首选模型（DeepSeek 现在的可选模型：deepseek-flash、deepseek-v4-pro） */
	model: 'deepseek-flash',
	/** 首选模型不可用时的回退顺序 */
	fallbackModels: ['deepseek-v4-pro'],
	/** 是否开启深度思考：'disabled' | 'enabled'。整题作答默认关闭，速度更快 */
	thinking: 'disabled',
	temperature: 0,
	/** 单题最大输出 token */
	maxTokens: 4000,
	/** 单次请求超时（秒）。OCS 自身超时是 60 秒，这里要留出余量 */
	timeoutSeconds: 35,
	/** 失败重试次数（含首次） */
	attempts: 2,
	/** 同时向 DeepSeek 发起的最大请求数 */
	concurrency: 4,
	/** 可选访问令牌：设置后 OCS 题库配置的 headers 里要带对应请求头 */
	token: '',
	/** 调用日志保留天数，0 表示不写日志 */
	logRetentionDays: 30,
	/** 是否允许局域网访问（默认只允许本机） */
	allowLan: false,
	/**
	 * 需要交截图 / 拍照 / 画图 的主观题是否直接留空。默认开启：
	 * 判断只看“作答框对应的那一小问”（复合题会先拆小问），所以不会再误伤
	 * 同一大题里贴代码、填文字的小问；真正只能交图的题直接留空，省额度也不瞎答。
	 */
	skipManualWork: true,
	/** 题干里带图（“如图”“下图”）的主观题是否留空。默认关闭，理由同上 */
	skipImageQuestions: false,
	/**
	 * 简答 / 编程题的答案是否转成 HTML 交给 OCS。
	 * OCS 用 innerHTML 写入答案，`\n` 会被折叠成空格、`<stdio.h>` 会被当成标签吃掉，
	 * 所以默认开启（换行写 `<br>`、尖括号转义、代码里的 `#` 写成 `&#35;`）。
	 */
	htmlAnswer: true,
	/**
	 * 编程题默认语言：题目没写明语言时按这个生成。
	 * 网课大多没写语言，模型容易答成 C++ / Python，这里默认 C（可改 C++ / Java / Python / auto）。
	 */
	codeLanguage: 'C'
};

export const CONFIG_FILE = 'config.json';

export function configPath(root) {
	// 自检脚本会通过 OCS_TIKU_CONFIG 指到临时文件，避免污染用户真实配置
	if (process.env.OCS_TIKU_CONFIG) return process.env.OCS_TIKU_CONFIG;
	return path.join(root, CONFIG_FILE);
}

/** 读取配置：默认值 ← config.json ← 环境变量 */
export function loadConfig(root) {
	const file = configPath(root);
	let stored = {};
	if (fs.existsSync(file)) {
		try {
			stored = JSON.parse(fs.readFileSync(file, 'utf8'));
		} catch (error) {
			throw new Error(`config.json 解析失败：${error.message}`);
		}
	}
	const config = { ...DEFAULT_CONFIG, ...stored };

	if (process.env.DEEPSEEK_API_KEY) config.apiKey = process.env.DEEPSEEK_API_KEY;
	if (process.env.OCS_TIKU_PORT) config.port = Number(process.env.OCS_TIKU_PORT);
	if (process.env.OCS_TIKU_MODEL) config.model = process.env.OCS_TIKU_MODEL;
	if (process.env.OCS_TIKU_HOST) config.host = process.env.OCS_TIKU_HOST;
	if (process.env.OCS_TIKU_MOCK === '1') config.mock = true;

	return normalizeConfig(config);
}

/** 修正明显写错的字段，避免把服务跑挂 */
export function normalizeConfig(config) {
	const next = { ...DEFAULT_CONFIG, ...config };

	next.port = clampInt(next.port, 1, 65535, DEFAULT_CONFIG.port);
	next.timeoutSeconds = clampInt(next.timeoutSeconds, 5, 120, DEFAULT_CONFIG.timeoutSeconds);
	next.maxTokens = clampInt(next.maxTokens, 64, 8192, DEFAULT_CONFIG.maxTokens);
	next.concurrency = clampInt(next.concurrency, 1, 16, DEFAULT_CONFIG.concurrency);
	next.attempts = clampInt(next.attempts, 1, 5, DEFAULT_CONFIG.attempts);
	next.temperature = Number.isFinite(Number(next.temperature)) ? Number(next.temperature) : 0;
	next.thinking = next.thinking === 'enabled' ? 'enabled' : 'disabled';
	next.apiKey = String(next.apiKey ?? '').trim();
	next.token = String(next.token ?? '').trim();
	next.model = String(next.model ?? DEFAULT_CONFIG.model).trim() || DEFAULT_CONFIG.model;
	next.baseUrl = String(next.baseUrl ?? DEFAULT_CONFIG.baseUrl).trim().replace(/\/+$/, '') || DEFAULT_CONFIG.baseUrl;
	next.fallbackModels = Array.isArray(next.fallbackModels)
		? next.fallbackModels.map((item) => String(item).trim()).filter(Boolean)
		: DEFAULT_CONFIG.fallbackModels;
	next.host = String(next.host ?? DEFAULT_CONFIG.host).trim() || DEFAULT_CONFIG.host;
	if (!/^https?:\/\//i.test(next.baseUrl)) next.baseUrl = DEFAULT_CONFIG.baseUrl;

	// 布尔开关：只有显式 false 才关掉，避免旧配置文件缺字段时行为变化
	next.skipManualWork = next.skipManualWork === true;
	next.skipImageQuestions = next.skipImageQuestions === true;
	next.htmlAnswer = next.htmlAnswer !== false;
	next.codeLanguage = ['C', 'C++', 'Java', 'Python', 'auto'].includes(next.codeLanguage)
		? next.codeLanguage
		: DEFAULT_CONFIG.codeLanguage;

	// 监听 0.0.0.0 才可能被局域网访问
	if (next.allowLan && (next.host === '127.0.0.1' || next.host === 'localhost')) next.host = '0.0.0.0';

	return next;
}

function clampInt(value, min, max, fallback) {
	const num = Number(value);
	if (!Number.isFinite(num)) return fallback;
	return Math.max(min, Math.min(max, Math.round(num)));
}

/** 原子写入配置 */
export function saveConfig(root, config) {
	const file = configPath(root);
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(config, null, '\t'), 'utf8');
	fs.renameSync(tmp, file);
}

/** 合并保存（只允许修改白名单字段） */
export function updateConfig(root, current, patch) {
	const next = { ...current };
	for (const key of [
		'apiKey',
		'model',
		'fallbackModels',
		'baseUrl',
		'thinking',
		'temperature',
		'maxTokens',
		'timeoutSeconds',
		'attempts',
		'concurrency',
		'token',
		'logRetentionDays',
		'allowLan',
		'skipManualWork',
		'skipImageQuestions',
		'htmlAnswer',
		'codeLanguage',
		'host',
		'port'
	]) {
		if (patch[key] !== undefined) next[key] = patch[key];
	}
	const normalized = normalizeConfig(next);
	saveConfig(root, normalized);
	return normalized;
}

/** 打码后的 Key，用于前端展示 */
export function maskKey(apiKey) {
	const key = String(apiKey ?? '');
	if (!key) return '';
	if (key.length <= 12) return `${key.slice(0, 3)}****`;
	return `${key.slice(0, 5)}****${key.slice(-4)}`;
}

/** 返回给浏览器的安全配置（不含明文 Key） */
export function publicConfig(config) {
	return {
		port: config.port,
		host: config.host,
		model: config.model,
		fallbackModels: config.fallbackModels,
		baseUrl: config.baseUrl,
		thinking: config.thinking,
		temperature: config.temperature,
		maxTokens: config.maxTokens,
		timeoutSeconds: config.timeoutSeconds,
		concurrency: config.concurrency,
		hasApiKey: Boolean(config.apiKey),
		apiKeyMasked: maskKey(config.apiKey),
		hasToken: Boolean(config.token),
		allowLan: config.allowLan,
		skipManualWork: config.skipManualWork === true,
		skipImageQuestions: config.skipImageQuestions === true,
		htmlAnswer: config.htmlAnswer !== false,
		codeLanguage: config.codeLanguage
	};
}
