/**
 * 题目 → 提示词 → DeepSeek → OCS 答案格式。
 * 这里集中处理“模型输出怎么变成 OCS 能点选的答案”，便于单独测试。
 */

import {
	TYPE_LABEL,
	hasSeparator,
	isJudgementOptions,
	judgementVerdict,
	looksLikeProgram,
	matchOption,
	normalizeType
} from './text.mjs';

/**
 * 系统提示词。
 * 要点：只输出 JSON；字母必须是选项里存在的；防复制乱码先还原再答；判断/填空单独给 text；
 * 需要看图/交截图的题直接 skip，避免瞎答。
 */
export const SYSTEM_PROMPT = `你是中国高校网课（学习通、智慧树、超星、雨课堂等）的答题助手，要给题干一个可以直接提交的标准答案。

内部思考（不要写进输出）：
1. 先还原题干：网课页面常有防复制乱码、错别字、多余的标点，先在内部还原成通顺的原句。
2. 再判断学科与考点，回忆教材里的标准表述，优先给“课本原话、标准结论”。
3. 逐项核对：多选题把每个选项单独判断真假；判断题留意“不属于、不正确、并非、没有”等否定词；计算题先算清楚再给结果。

作答规则：
1. 只依据题干与选项作答，可结合学科常识，不要因为题干个别字奇怪就拒答。
2. 单选题：letters 恰好 1 个。多选题：letters 至少 1 个、不重复、按字母升序。判断题：letters 选“对/正确”或“错/错误”对应的选项字母。
3. letters 必须是题目里真实存在的选项字母，绝对不能虚构；没有选项时 letters 必须为空数组。
4. 填空题 / 简答题：letters 留空，答案写在 text：
   - 有多个空时，按顺序用 # 分隔，例如 "80#443"。
   - 简答题给 3 句以内、分点清晰的答案，用 1. 2. 3. 编号，不要用 markdown 符号或加粗。
   - 编程题给完整可运行的代码（包含 #include 等头文件），用真实换行，不要用 \`\`\` 包裹，不要写解释。
5. 只有一种情况可以 skip：题目要求你「把答案做成截图/图片上传」，而且题目本身没有留下任何用文字作答的余地（例如“运行程序并截图上传，截图需包含源代码和运行结果”，而题目只给了图片上传框）。
   以下情况一律**不要** skip，正常给答案：
   - 题干里只是顺带提了一句“截图”（多半是整道大题的提交说明），下面的小题仍然要你选/填；
   - 题目说“贴源代码 / 粘贴代码 / 不要截图 / 直接写代码”；
   - 题目说“参考答案是截图 / 示例见截图”——那只是在说明参考答案的形式；
   - 选择题、判断题提到了图片：按文字信息尽量推断，不要留空。
6. 必须看图才能确认的客观题：仍然给出最可能的答案，并在 note 里说明依据；不要因为看不到图就 skip。
7. 只输出一个 JSON 对象，不要 markdown 代码块，不要任何前后解释文字。

输出格式：
{"kind":"single|multiple|judgement|completion|skip","letters":["A"],"text":"","confidence":0.95,"note":"一句话理由"}`;

/** 题型在提示词里的写法 */
const KIND_HINT = {
	single: '单选题（只能选 1 项）',
	multiple: '多选题（可能选多项）',
	judgement: '判断题（判断对错）',
	completion: '填空题（填文字，不需要选项字母）',
	unknown: '题型未知（请自行判断单选/多选/判断/填空）'
};

/**
 * 构造对话消息。
 * @param {{title: string, type: string, options: {letter: string, text: string, raw: string}[], hint?: string}} payload
 */
export function buildMessages({ title, type, options, hint }) {
	const kind = normalizeType(type);
	const lines = [
		`【题型】${KIND_HINT[kind] || KIND_HINT.unknown}`,
		`【题干】${String(title ?? '').trim()}`
	];

	if (Array.isArray(options) && options.length) {
		lines.push('【选项】');
		for (const option of options) {
			lines.push(`${option.letter}. ${option.text}`);
		}
	} else {
		lines.push('【选项】（无，本题为填空题或题干自带答案空位）');
	}

	if (hint) {
		lines.push(`【补充】${hint}`);
	}

	lines.push('请按系统要求只输出 JSON。');

	return [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user', content: lines.join('\n') }
	];
}

/** 从模型返回的 content 里解析出结构化答案（尽量宽容，解析失败也返回可用信息） */
export function parseModelOutput(content) {
	const raw = String(content ?? '').trim();
	if (!raw) {
		throw new Error('DeepSeek 返回空内容');
	}

	let jsonText = raw;
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
	if (fenced && fenced[1]) jsonText = fenced[1].trim();
	const start = jsonText.indexOf('{');
	const end = jsonText.lastIndexOf('}');
	if (start !== -1 && end > start) jsonText = jsonText.slice(start, end + 1);

	let data;
	try {
		data = JSON.parse(jsonText);
	} catch {
		// 兜底：模型没按 JSON 输出时，从纯文本里提取字母答案
		const letters = extractLettersFromText(raw);
		return {
			kind: 'unknown',
			letters,
			text: letters.length ? '' : raw.slice(0, 300),
			confidence: letters.length ? 0.5 : 0,
			note: '模型未按 JSON 格式输出，已按文本解析',
			parsed: false
		};
	}

	const letters = normalizeLetters(
		data.letters ??
			data.answer_letters ??
			data.answerLetters ??
			data.options_letters ??
			data.letter ??
			(typeof data.answer === 'string' && /^[A-Za-z]{1,8}$/.test(data.answer.trim()) ? data.answer : undefined)
	);

	let text = '';
	const textField = data.text ?? data.answer_text ?? data.fill ?? data.content ?? data.completion;
	if (typeof textField === 'string') text = textField.trim();
	if (!text && typeof data.answer === 'string' && !letters.length) text = data.answer.trim();
	if (!text && Array.isArray(data.blanks)) {
		text = data.blanks
			.map((item) => String(item ?? '').trim())
			.filter(Boolean)
			.join('#');
	}

	let confidence = Number(data.confidence ?? data.score ?? 0);
	if (!Number.isFinite(confidence)) confidence = 0;
	if (confidence > 1 && confidence <= 100) confidence = confidence / 100;
	confidence = Math.max(0, Math.min(1, confidence));

	const kind = normalizeType(data.kind ?? data.type ?? data.question_type ?? '');
	const note = String(data.note ?? data.reason ?? data.explanation ?? '').trim();

	// 模型主动放弃（需要看图 / 要交截图）
	const kindRaw = String(data.kind ?? data.type ?? '').toLowerCase();
	const skipped = data.skip === true || /skip|manual|image|截图|图片|不会|无法/.test(kindRaw);

	return { kind: skipped ? 'skip' : kind, letters, text, confidence, note, parsed: true };
}

/** 把各种写法的字母集合统一成 ['A','C'] 形式 */
export function normalizeLetters(input) {
	if (input === undefined || input === null) return [];
	const source = Array.isArray(input) ? input.join('') : String(input);
	const letters = [];
	for (const ch of source.toUpperCase()) {
		if (ch >= 'A' && ch <= 'Z' && !letters.includes(ch)) letters.push(ch);
	}
	letters.sort();
	return letters.slice(0, 26);
}

/** 从一段自然语言里提取 “答案：AC”“选 A” 之类 */
function extractLettersFromText(text) {
	const m = /(?:答案|正确答案|选|选项|answer)\s*[:：是为]?\s*([A-Za-z][A-Za-z\s,，、/]*)/i.exec(text);
	if (!m) return [];
	return normalizeLetters(m[1]);
}

/** HTML 转义：富文本编辑器用 innerHTML 写答案，不转义会丢内容 */
export function escapeHtmlText(text) {
	return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 把纯文本答案转成富文本编辑器能正确显示的 HTML。
 *
 * OCS 用 `body.innerHTML = answer`（或 ueditor 的 setContent）写入简答/编程题，
 * 所以：`\n` 要写成 `<br>`（否则被 HTML 折叠成空格）、`<stdio.h>` 必须转义（否则被当标签吃掉）、
 * 程序代码里的 `#` 还要写成 `&#35;`（否则被 splitAnswer 当成多空分隔符切掉）。
 */
export function textToRichHtml(text, { escapeHash = false } = {}) {
	const normalized = String(text).replace(/\r\n?/g, '\n');
	let html = escapeHtmlText(normalized);
	if (escapeHash) html = html.replace(/#/g, '&#35;');
	return html
		.split('\n')
		.map((line) => line.trimEnd())
		.join('<br>');
}

/**
 * 简答 / 填空题的最终答案字符串。
 * - 纯多空填空（`a#b`）：保持纯文本，`#` 就是 OCS 的多空分隔符
 * - 带换行 / 尖括号 / 代码里的 `#`：转成 HTML，否则内容会被 innerHTML 吃掉
 */
export function formatCompletionAnswer(text, { html = true } = {}) {
	const raw = String(text ?? '').trim();
	if (!raw) return '';
	if (!html) return raw;

	// 代码：整段转义（尖括号、&），换行 <br>，'#' 写成 &#35; 躲开 OCS 的分隔符切分。
	// 代码里的 {} ; 会让 OCS 判定为“程序答案”，从而豁免 ; | ； 三个分隔符，转义带出的分号不会误切。
	if (looksLikeProgram(raw)) {
		return textToRichHtml(raw, { escapeHash: true });
	}

	// 单行填空：原样返回（多空答案依赖 # 作为分隔符）
	if (!raw.includes('\n')) return raw;

	// 多行简答：只把换行变 <br>。这里刻意不转义 & < >（转义产生的 ; 会被 OCS 当分隔符把答案切碎），
	// 同时把 # 换成全角，避免被 splitAnswer 切开。
	return raw
		.split('\n')
		.map((line) => line.trimEnd())
		.join('<br>')
		.replace(/#/g, '＃');
}

/**
 * 把模型答案格式化成 OCS 能识别的答案字符串。
 *
 * 规则（对应 ocsjs 的 resolveSingle / resolveMultiple / resolveJudgement / resolveCompletion）：
 * - 单选、多选、判断：优先返回“选项原文”（归一化后必然命中第一阶段的精确匹配）
 * - 选项原文里含有 OCS 分隔符（# | ; ； 等）时改用字母，走“纯ABCD”兜底
 * - 判断题必须返回“对/正确/错/错误”或对应选项原文，字母对 resolveJudgement 无效
 * - 填空题返回文本，多个空用 # 分隔
 *
 * @param {{type: string, options: {letter: string, text: string, raw: string}[], model: ReturnType<typeof parseModelOutput>}} params
 */
export function formatAnswer({ type, options, model, html = true }) {
	const opts = Array.isArray(options) ? options : [];
	model = model || {};

	// 模型主动放弃（题目要截图/画图/看图）
	if (model.kind === 'skip') {
		return {
			kind: 'skip',
			answer: '',
			letters: [],
			picked: [],
			mode: 'skip',
			warning: model.note || '题目需要看图或提交截图，已留空'
		};
	}

	let kind = normalizeType(type);
	const warnings = [];

	// 题型未知时做一些推断
	if (kind === 'unknown') {
		if (isJudgementOptions(opts)) kind = 'judgement';
		else if (model.kind && model.kind !== 'unknown') kind = model.kind;
		else kind = opts.length ? 'single' : 'completion';
	}

	// 字母必须落在选项范围内
	const rawLetters = Array.isArray(model.letters) ? model.letters : [];
	const letters = rawLetters.filter((letter) => {
		const index = letter.charCodeAt(0) - 65;
		return index >= 0 && index < opts.length;
	});
	if (rawLetters.length && !letters.length) {
		warnings.push('模型给出的选项字母不在本题选项范围内，已改用文本匹配');
	}

	const pick = (letter) => opts[letter.charCodeAt(0) - 65];

	if (kind === 'judgement') {
		let verdict;
		if (letters.length) {
			verdict = judgementVerdict(pick(letters[0]).text);
		}
		if (verdict === undefined && letters.length) {
			// 选项文本本身不像判断词（例如 “A、这句诗出自杜甫”），按“选第一个=对”处理
			verdict = letters[0] === 'A';
		}
		if (verdict === undefined && model.text) verdict = judgementVerdict(model.text);
		if (verdict === undefined) {
			return { kind, answer: '', letters: [], picked: [], mode: 'none', warning: '无法判断对错' };
		}
		const target = opts.find((option) => judgementVerdict(option.text) === verdict);
		if (target) {
			return { kind, answer: target.raw, letters: [target.letter], picked: [target.raw], mode: 'option', verdict };
		}
		return { kind, answer: verdict ? '对' : '错', letters, picked: [], mode: 'text', verdict };
	}

	if (kind === 'completion') {
		const text = (model.text || '').trim();
		if (!text) {
			return { kind, answer: '', letters: [], picked: [], mode: 'none', warning: '模型未给出填空答案' };
		}
		const answer = formatCompletionAnswer(text, { html });
		return {
			kind,
			answer,
			letters: [],
			picked: [],
			mode: answer === text ? 'text' : 'html',
			warning: warnings.length ? warnings.join('；') : undefined
		};
	}

	// 单选 / 多选（含未知但按选择题处理的情况）
	if (!opts.length) {
		const text = (model.text || '').trim();
		return { kind, answer: text, letters: [], picked: [], mode: text ? 'text' : 'none' };
	}

	let picked = letters.map((letter) => pick(letter)).filter(Boolean);

	// 没有可用字母时，用文本答案反过来匹配选项
	if (!picked.length && model.text) {
		const fragments =
			kind === 'multiple'
				? model.text
						.split(/[#;；,，、|]/)
						.map((item) => item.trim())
						.filter(Boolean)
				: [model.text];
		picked = fragments.map((fragment) => matchOption(opts, fragment)).filter(Boolean);
	}

	if (!picked.length) {
		const text = (model.text || '').trim();
		return {
			kind,
			answer: text,
			letters: [],
			picked: [],
			mode: text ? 'text' : 'none',
			warning: text ? undefined : '未能匹配到任何选项'
		};
	}

	picked = kind === 'single' ? picked.slice(0, 1) : picked;

	// 选项原文含分隔符时，OCS 会把答案切碎，改用字母兜底
	if (picked.some((option) => hasSeparator(option.raw))) {
		warnings.push('选项文本含分隔符，已改用字母作答');
		const lettersOnly = picked.map((option) => option.letter);
		if (lettersOnly.length === 1) {
			return { kind, answer: lettersOnly[0], letters: lettersOnly, picked: [], mode: 'letters', warning: warnings.join('；') };
		}
		if (lettersOnly.length <= 8) {
			return { kind, answer: lettersOnly.join(''), letters: lettersOnly, picked: [], mode: 'letters', warning: warnings.join('；') };
		}
	}

	const raws = picked.map((option) => option.raw);
	const answer = kind === 'multiple' || raws.length > 1 ? raws.join('#') : raws[0];
	return {
		kind,
		answer,
		letters: picked.map((option) => option.letter),
		picked: raws,
		mode: 'option',
		warning: warnings.length ? warnings.join('；') : undefined
	};
}

/** 给界面展示用的题型中文名 */
export function typeLabel(type) {
	return TYPE_LABEL[normalizeType(type)] || TYPE_LABEL.unknown;
}
