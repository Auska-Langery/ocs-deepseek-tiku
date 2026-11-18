/**
 * 文本处理工具：题目归一化、选项解析、答案清洗。
 * 只依赖 Node 内置能力，无第三方依赖。
 */

const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const CJK_PUNCT =
	'，。、；：？！…—～·「」『』【】《》〈〉“”‘’（）〔〕［］｛｝＜＞／＼＾＿＋－×÷＝　＃＠＆＊';

/** 归一化时需要丢弃的字符集合（标点、空白、各类符号） */
const DROP_SET = new Set([...ASCII_PUNCT, ...CJK_PUNCT, ' ', '\t', '\n', '\r', '\u00a0', '\u3000']);

/** 题型噪声前缀，如【单选题】、（多选）、[判断] 等 */
const TYPE_NOISE_RE =
	/^\s*[【\[（(]?\s*(?:单项选择题|多项选择题|单选题|多选题|判断题|填空题|选择题|不定项选择题|单选|多选|判断|填空)\s*[】\]）)]?\s*[:：、.．]?\s*/;

/** 题号前缀，如 “1.” “（2）” “第3题” “4、” */
const NUMBER_NOISE_RE = /^\s*(?:第\s*\d+\s*题\s*[:：、.．]?|[（(]\s*\d+\s*[）)]|\d+\s*[、.．:：)）])\s*/;

/**
 * 归一化文本：用于题目缓存键与选项比对。
 * 全角转半角 → 小写 → 去掉所有空白与标点。
 */
export function normalizeText(input) {
	if (input === undefined || input === null) return '';
	const text = String(input).normalize('NFKC').toLowerCase();
	let out = '';
	for (const ch of text) {
		if (DROP_SET.has(ch)) continue;
		out += ch;
	}
	return out;
}

/**
 * 去掉题干中的题型标记、题号、以及末尾的空括号，得到“干净题干”。
 * 只影响缓存键与展示，不影响提交给模型的原文。
 */
export function stripQuestionNoise(input) {
	let text = String(input ?? '').replace(/\r\n?/g, '\n').trim();
	text = text.replace(TYPE_NOISE_RE, '');
	text = text.replace(NUMBER_NOISE_RE, '');
	// 题干末尾常见的 “（ ）”“(  )” 空括号
	text = text.replace(/[（(]\s*[）)]\s*$/g, '');
	return text.trim();
}

/** 生成题目缓存键：题型 + 归一化题干 */
export function questionKey(title, type) {
	return `${type || 'unknown'}|${normalizeText(stripQuestionNoise(title))}`;
}

/** HTML 转义（服务端渲染错误信息时使用） */
export function escapeHtml(str) {
	return String(str ?? '').replace(/[&<>"']/g, (ch) => {
		switch (ch) {
			case '&':
				return '&amp;';
			case '<':
				return '&lt;';
			case '>':
				return '&gt;';
			case '"':
				return '&quot;';
			default:
				return '&#39;';
		}
	});
}

/**
 * 「必须交截图 / 交图片」的指令：只有主观题（简答、编程、问答）命中才留空。
 * 注意：只是题干里提了一句「截图」（比如提交说明），或明确说「贴源代码，不要截图」的，都不算。
 */
const MANUAL_UPLOAD_PATTERNS = [
	/(上传|提交|附上|附带)[^。；\n]{0,10}(截图|截屏|图片|照片)/,
	/(截图|截屏|图片|照片|拍照|手写)[^。；\n]{0,10}(上传|提交)/,
	/(运行|执行)[^。；\n]{0,8}(程序|代码)[^。；\n]{0,8}(截图|截屏)/,
	/(请|需|须|务|然后|再)[^。；\n]{0,6}(截图|截屏)/,
	/(截图|截屏)[^。；\n]{0,10}(需|必须|要)(包含|显示|含)/,
	/作图|画图|绘图|画出[^。；\n]{0,8}(图|流程|示意)/
];

/** 明确要求「用文字作答」的指令：只要出现，就不能因为题干里提到截图而留空 */
const TEXT_ANSWER_PATTERNS = [
	/(贴|粘贴|输入|写出|填写|录入|提供)[^。；\n]{0,8}(代码|源码|源程序|程序|文字|答案|步骤)/,
	/(不要|不用|无需|不必|禁止|切勿|别)[^。；\n]{0,6}(截图|截屏|拍照|图片)/
];

/** 题干里带图（含「如图」「下图」等指代）的题目：模型无法看图，硬答基本是错的 */
const IMAGE_QUESTION_PATTERNS = [
	/如图|见图|如下图|上图|下图|图中所示|如图中|如图为/,
	/【图片】|\[图片\]|\(图片\)|（图片）|【图】|\[图\]|\(图\)|（图）/
];

/** 判断题目是不是「要人交截图/画图」的那类（只对主观题有意义） */
// 「编写函数 / 实现程序 / main 函数」这类题即使在末尾要求「运行程序并截图」，
// 也应该照常给出代码（用户要的是能贴进作答框的源码），不能整题留空。
const CODE_TASK_PATTERN =
	/(编写|实现|设计|完成|定义|改错|调试)[^。；\n]{0,12}(函数|程序|代码|算法)|(截图|截屏|运行|编译|执行)[^。；\n]{0,12}(源代码|源程序|程序|代码)|main\s*函数|#include|printf\s*\(|scanf\s*\(/;

export function needsManualWork(title) {
	const text = String(title ?? '');
	if (CODE_TASK_PATTERN.test(text)) return false;
	if (!text.trim()) return false;
	if (TEXT_ANSWER_PATTERNS.some((pattern) => pattern.test(text))) return false;
	return MANUAL_UPLOAD_PATTERNS.some((pattern) => pattern.test(text));
}

/** 判断题目是不是「带图片、模型看不到图」的那类 */
export function looksLikeImageQuestion(title) {
	const text = String(title ?? '');
	if (!text.trim()) return false;
	return IMAGE_QUESTION_PATTERNS.some((pattern) => pattern.test(text));
}

/** 粗略判断一段文本是不是程序代码（用于决定是否要转义 # 和换行） */
export function looksLikeProgram(text) {
	const raw = String(text ?? '');
	if (!raw.trim()) return false;
	return /[{}]|#include|#define|int\s+main|printf\s*\(|scanf\s*\(|for\s*\(|while\s*\(|def\s+\w+\(|:\s*$/m.test(raw);
}

/** 统一题型名称：OCS 传入的可能是 single / multiple / judgement / completion，也可能是中文 */
export function normalizeType(rawType) {
	const text = String(rawType ?? '').toLowerCase();
	if (/judge|判断|对错|true.?false/.test(text)) return 'judgement';
	if (/multi|多选|多项|不定项/.test(text)) return 'multiple';
	if (/single|单选|单项/.test(text)) return 'single';
	if (/completion|fill|填空|简答|问答/.test(text)) return 'completion';
	return 'unknown';
}

/** 题型中文名，用于日志与界面 */
export const TYPE_LABEL = {
	single: '单选题',
	multiple: '多选题',
	judgement: '判断题',
	completion: '填空题',
	unknown: '未知题型'
};

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * 解析选项文本。
 * OCS 传入的 options 是换行分隔的选项文本，通常已带 “A.” “A、”“(A)” 之类前缀，
 * 这里统一剥离成纯文本并标上字母；前缀不规整时按顺序补字母。
 *
 * @param {string|string[]} raw
 * @returns {{letter: string, text: string, raw: string}[]}
 */
export function parseOptions(raw) {
	if (raw === undefined || raw === null) return [];
	const lines = Array.isArray(raw)
		? raw.map((line) => String(line ?? ''))
		: String(raw).replace(/\r\n?/g, '\n').split('\n');

	const cleaned = lines.map((line) => line.replace(/\u00a0/g, ' ').trim());

	// 有的页面会把多个选项塞进一行，如 “A.甲 B.乙 C.丙”，按 “空格+字母+分隔符” 再拆一次
	const split = [];
	for (const line of cleaned) {
		if (!line) continue;
		const parts = splitInlineOptions(line);
		split.push(...parts);
	}

	const nonEmpty = split.filter((line) => line.length > 0);
	if (nonEmpty.length === 0) return [];

	// 检测统一前缀：A. / A、/ A) / (A) / A：
	const prefixed = nonEmpty.map((line) => matchOptionPrefix(line));
	const hasUniformPrefix =
		prefixed.every((item, index) => item && item.letter === LETTERS[index]);

	return nonEmpty.map((line, index) => {
		if (hasUniformPrefix && prefixed[index]) {
			return { letter: LETTERS[index], text: prefixed[index].text, raw: line };
		}
		return { letter: LETTERS[index], text: line, raw: line };
	});
}

/** 把 “A.甲 B.乙 C.丙”“A、甲   B、乙” 这种一行多选项拆开；普通句子保持原样 */
function splitInlineOptions(line) {
	// 注意：不吞掉标记后的空白，否则下一次匹配会从字母处开始、丢掉前导空格，导致漏匹配
	const re = /(^|\s)(?:[（(]?([A-Za-z])[)）][.、．:：]?|([A-Za-z])[.、．:：])/g;
	const markers = [];
	let match;
	while ((match = re.exec(line)) !== null) {
		const letter = (match[2] || match[3] || '').toUpperCase();
		if (!letter) continue;
		markers.push({ letter, start: match.index + match[1].length, end: re.lastIndex });
	}
	if (markers.length < 2) return [line];

	// 只认从 A 开始的连续字母（A,B,C...），避免把正文里的 “B.” 当成选项
	if (markers[0].letter !== 'A') return [line];
	for (let i = 0; i < markers.length; i++) {
		if (markers[i].letter !== LETTERS[i]) return [line];
	}

	const parts = [];
	const head = line.slice(0, markers[0].start).trim();
	const pieces = [];
	for (let i = 0; i < markers.length; i++) {
		const end = i + 1 < markers.length ? markers[i + 1].start : line.length;
		pieces.push(`${markers[i].letter}.` + line.slice(markers[i].end, end).trim());
	}
	if (head) parts.push(head);
	parts.push(...pieces);
	return parts;
}

/** 匹配单个选项前缀，返回 {letter, text}，不匹配返回 null */
function matchOptionPrefix(line) {
	const m =
		/^\s*[（(]?([A-Za-z])[）)]?\s*(?:[.、．:：,，]|\s)\s*(.*)$/.exec(line) ||
		/^\s*([A-Za-z])\s*$/.exec(line);
	if (!m) return null;
	const text = (m[2] ?? '').trim();
	if (!text) return null;
	// “A.” 后面直接是英文单词的情况（如 “A. Smith” 是正文）仍按前缀处理，选项场景下风险很低
	return { letter: m[1].toUpperCase(), text };
}

/** 答案里的分隔符（与 OCS 默认一致：=== # --- ### | ; ；） */
export const OCS_SEPARATORS = ['===', '#', '---', '###', '|', ';', '；'];
const UNSAFE_IN_TEXT_RE = /===|###|---|#|\||;|；/;

/** 文本中是否含有会被 OCS 当作答案分隔符的字符 */
export function hasSeparator(text) {
	return UNSAFE_IN_TEXT_RE.test(String(text ?? ''));
}

/** 判断题“正确”类答案词 */
const CORRECT_WORDS = ['正确', '对的', '是的', '正确的', '确定', '对', '是', '√', 'true', 'yes', 't', '1'];
/** 判断题“错误”类答案词 */
const WRONG_WORDS = ['不正确', '不正确的', '不对', '不是', '错误', '错的', '错', '非', '否', '×', 'false', 'no', 'f', '0'];

/** 去掉标点后再比较，避免 “对。” 与 “对” 不相等 */
function looseCompare(text) {
	return normalizeText(text);
}

/** 判断一段文本表达的是“正确”还是“错误”，无法判断返回 undefined */
export function judgementVerdict(text) {
	const value = looseCompare(text);
	if (!value) return undefined;

	// 1. 完全相等
	if (WRONG_WORDS.some((word) => looseCompare(word) === value)) return false;
	if (CORRECT_WORDS.some((word) => looseCompare(word) === value)) return true;

	// 2. 包含判断：先否定词（“不对”“不正确”里也含“对”，必须先判否定），再肯定词
	if (WRONG_WORDS.some((word) => value.includes(looseCompare(word)))) return false;
	if (CORRECT_WORDS.some((word) => value.includes(looseCompare(word)))) return true;

	return undefined;
}

/** 选项文本是否像判断题选项（两项且一正一误） */
export function isJudgementOptions(options) {
	if (!Array.isArray(options) || options.length !== 2) return false;
	const verdicts = options.map((item) => judgementVerdict(item.text));
	return verdicts.includes(true) && verdicts.includes(false);
}

/** 在选项里找到与给定答案文本对应的选项（严格归一化相等 → 包含 → 相似度） */
export function matchOption(options, answerText) {
	if (!Array.isArray(options) || options.length === 0) return undefined;
	const key = normalizeText(answerText);
	if (!key) return undefined;

	// 1. 完全相等
	const exact = options.find((item) => normalizeText(item.text) === key || normalizeText(item.raw) === key);
	if (exact) return exact;

	// 2. 答案是选项的子串或反之（取最长匹配，避免 “TCP” 命中 “TCP/IP协议” 之外的误选）
	let best;
	let bestScore = 0;
	for (const item of options) {
		const optionKey = normalizeText(item.text);
		if (!optionKey) continue;
		if (optionKey.includes(key) || key.includes(optionKey)) {
			const score = Math.min(optionKey.length, key.length) / Math.max(optionKey.length, key.length);
			if (score > bestScore) {
				best = item;
				bestScore = score;
			}
		}
	}
	if (best && bestScore >= 0.6) return best;

	// 3. 双字组相似度（轻量版 Dice 系数），阈值 0.6
	let diceBest;
	let diceScore = 0;
	for (const item of options) {
		const score = diceCoefficient(normalizeText(item.text), key);
		if (score > diceScore) {
			diceBest = item;
			diceScore = score;
		}
	}
	if (diceBest && diceScore >= 0.6) return diceBest;
	return undefined;
}

/** 双字组 Dice 相似度，0~1 */
export function diceCoefficient(a, b) {
	if (!a || !b) return 0;
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
	const grams = new Map();
	for (let i = 0; i < a.length - 1; i++) {
		const gram = a.slice(i, i + 2);
		grams.set(gram, (grams.get(gram) || 0) + 1);
	}
	let hits = 0;
	for (let i = 0; i < b.length - 1; i++) {
		const gram = b.slice(i, i + 2);
		const count = grams.get(gram) || 0;
		if (count > 0) {
			grams.set(gram, count - 1);
			hits++;
		}
	}
	return (2 * hits) / (a.length - 1 + b.length - 1);
}

/** 把任意输入的安全截断，用于日志/响应体 */
export function truncate(input, max = 500) {
	const text = String(input ?? '');
	return text.length > max ? text.slice(0, max) + '…' : text;
}

/** 生成短随机 id */
export function shortId() {
	return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ---------------------------------------------------------- 复合题：一道大题下面的多个小问

/**
 * 小问编号标记：(1) （1） 1. 1、 等，且必须出现在行首或空白之后，
 * 避免把「2024年」「3.14」这类数字当成小问编号。
 */
const SUBQ_MARKER = /(^|[\s\u3000])(?:[（(]\s*([0-9]{1,2})\s*[)）]|([0-9]{1,2})\s*[.、．](?!\d))/g;

/**
 * 把「大题干 + (1)(2)(3) 多个小问」拆开。
 *
 * 网课平台常把一整道复合题（选择题 + 判断题 + 填空题混排）当成一道题发给题库，
 * 而页面上的文字作答框只对应其中一个小问。拆出来之后才能只回答该小问。
 *
 * @param {string} title 题干原文
 * @returns {{n: number, text: string}[]} 编号递增的小问列表；不足 2 段返回空数组
 */
export function splitSubQuestions(title) {
	const text = String(title ?? '').replace(/\r\n?/g, '\n');
	const markers = [];
	SUBQ_MARKER.lastIndex = 0;
	let match;
	while ((match = SUBQ_MARKER.exec(text))) {
		const num = Number(match[2] ?? match[3]);
		if (!Number.isFinite(num)) continue;
		const previous = markers[markers.length - 1];
		if (previous && num <= previous.n) continue; // 编号必须递增，重复的当正文
		markers.push({ n: num, start: match.index, end: match.index + match[0].length });
	}
	if (markers.length < 2) return [];

	const parts = [];
	for (let i = 0; i < markers.length; i++) {
		const from = markers[i].end;
		const to = i + 1 < markers.length ? markers[i + 1].start : text.length;
		const body = cleanSubQuestionText(text.slice(from, to));
		if (body) parts.push({ n: markers[i].n, text: body });
	}
	return parts.length >= 2 ? parts : [];
}

/**
 * 小问正文清洗：压平空白，并砍掉题干里夹带的编辑器脚本
 * （超星的 UEditor 会把 `$(function(){…UE.getEditor(…)…})` 整段吐进标题里）。
 */
function cleanSubQuestionText(input) {
	let body = String(input ?? '');
	const scriptAt = body.search(/\$\(function\s*\(|window\.UEDITOR_CONFIG|UE\.getEditor\s*\(|var\s+editor\d*\s*=/);
	if (scriptAt > 0) body = body.slice(0, scriptAt);
	body = body
		.replace(/点击上传\s*\w*/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return body.length > 1200 ? body.slice(0, 1200) + '…' : body;
}

/** 判断某个小问更适合用「文字作答框」来答（而不是上传截图/图片） */
const TEXT_BOX_HINTS = [
	{ re: /(贴|粘贴|复制|输入|写出|填写|录入)[^。；\n]{0,12}(代码|程序|源码|源程序)/, score: 6 },
	{ re: /(编写|实现|设计|完成)[^。；\n]{0,10}(程序|代码|函数|算法)/, score: 5 },
	{ re: /第\s*\d*\s*空|填空|简答|问答|文字作答/, score: 4 },
	{ re: /(不要|不用|无需|不必|不能)[^。；\n]{0,6}(截图|截屏|拍照|图片)/, score: 4 },
	{ re: /上传|截图|截屏|拍照|图片|照片/, score: -3 }
];

/**
 * 从复合题的小问里挑出「页面上那个文字输入框」对应的小问。
 *
 * 依据：文字框能填的必然是代码/填空/简答类小问；要求上传截图的小问打负分。
 * 分数相同取靠后的（大题一般把主观作答放在最后）。
 *
 * @param {{n: number, text: string}[]} parts
 * @returns {{n: number, text: string, index: number, score: number} | null}
 */
export function pickTextBoxPart(parts) {
	if (!Array.isArray(parts) || parts.length === 0) return null;
	let best = null;
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		let score = 0;
		for (const hint of TEXT_BOX_HINTS) {
			if (hint.re.test(part.text)) score += hint.score;
		}
		const candidate = { n: part.n, text: part.text, index, score };
		if (!best || candidate.score >= best.score) best = candidate;
	}
	return best;
}
