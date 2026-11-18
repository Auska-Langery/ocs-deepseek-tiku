#!/usr/bin/env node
/**
 * 自动自检：不需要 API Key，使用 mock 模式验证整套逻辑。
 *
 * 运行：node selftest.mjs
 *   - 第一部分：纯函数单测（选项解析、答案格式化、模型输出解析）
 *   - 第二部分：起一个临时服务（127.0.0.1 随机端口 + 临时数据目录），
 *     真实走一遍 HTTP 接口：答题、缓存命中、判断/多选/填空、题库增删查导、CORS、静态页
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatAnswer, parseModelOutput } from './lib/answer.mjs';
import { judgementVerdict, looksLikeImageQuestion, needsManualWork, parseOptions } from './lib/text.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `ocs-tiku-selftest-${Date.now()}`);

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
	if (condition) {
		passed++;
		console.log(`  \x1b[32m✓\x1b[0m ${name}`);
	} else {
		failed++;
		failures.push(name + (detail ? ` -> ${detail}` : ''));
		console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` -> ${detail}` : ''}`);
	}
}

function section(title) {
	console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// ---------------------------------------------------------------- 纯函数

section('1. 选项解析 / 答案格式化');

const singleOptions = parseOptions('A. 北京\nB. 上海\nC. 广州\nD. 深圳');
check('解析 4 个选项', singleOptions.length === 4, `实际 ${singleOptions.length}`);
check('选项字母 A-D', singleOptions.map((option) => option.letter).join('') === 'ABCD');
check('选项文本去掉前缀', singleOptions[1].text === '上海', singleOptions[1].text);

const inlineOptions = parseOptions('A、甲   B、乙   C、丙');
check('一行多选项可拆分', inlineOptions.length === 3, `实际 ${inlineOptions.length}`);

const plainOptions = parseOptions('北京\n上海');
check('无字母前缀也能解析', plainOptions.length === 2 && plainOptions[0].text === '北京');

const singleAnswer = formatAnswer({ type: 'single', options: singleOptions, model: { letters: ['B'] } });
check('单选返回选项原文', singleAnswer.answer === 'B. 上海', singleAnswer.answer);

const multipleAnswer = formatAnswer({
	type: 'multiple',
	options: parseOptions('A. HTML\nB. Java\nC. CSS\nD. Python'),
	model: { letters: ['A', 'C'] }
});
check('多选用 # 连接选项原文', multipleAnswer.answer === 'A. HTML#C. CSS', multipleAnswer.answer);

const judgementAnswer = formatAnswer({
	type: 'judgement',
	options: parseOptions('A. 对\nB. 错'),
	model: { text: '正确' }
});
check('判断题返回选项原文', judgementAnswer.answer === 'A. 对', judgementAnswer.answer);

const judgementByLetter = formatAnswer({
	type: 'judgement',
	options: parseOptions('A. 正确\nB. 错误'),
	model: { letters: ['B'] }
});
check('判断题按字母也能落到“错误”选项', judgementByLetter.answer === 'B. 错误', judgementByLetter.answer);

const completionAnswer = formatAnswer({ type: 'completion', options: [], model: { text: '80#443' } });
check('填空题多空用 # 分隔', completionAnswer.answer === '80#443', completionAnswer.answer);

check('判断题文本识别：不正确 => 错', judgementVerdict('不正确') === false);
check('判断题文本识别：对的 => 对', judgementVerdict('对的') === true);

const fenced = parseModelOutput('```json\n{"kind":"single","letters":["a","c"],"confidence":0.9}\n```');
check('解析 ```json 围栏', fenced.letters.join('') === 'AC', JSON.stringify(fenced.letters));

const looseText = parseModelOutput('我认为答案是 B，因为……');
check('解析散装文本里的字母', looseText.letters.join('') === 'B', JSON.stringify(looseText.letters));

const separatorOption = formatAnswer({
	type: 'single',
	options: parseOptions('A. 甲；乙\nB. 丙'),
	model: { letters: ['A'] }
});
check('选项含分隔符时改用字母，避免被 OCS 拆开', separatorOption.answer === 'A', separatorOption.answer);

// 简答 / 编程题的富文本处理
const codeAnswer = formatAnswer({
	type: 'completion',
	options: [],
	model: { text: '#include <stdio.h>\nint main() {\n  printf("hi");\n  return 0;\n}' }
});
check('编程题答案转成 HTML', codeAnswer.mode === 'html', codeAnswer.mode);
check('代码里的 #include 不再被当分隔符', codeAnswer.answer.includes('&#35;include'), codeAnswer.answer.slice(0, 40));
check(
	'代码里的 <stdio.h> 被转义',
	codeAnswer.answer.includes('&lt;stdio.h&gt;') && !codeAnswer.answer.includes('<stdio'),
	codeAnswer.answer.slice(0, 40)
);
check('代码里的换行变成 <br>', codeAnswer.answer.includes('<br>'), codeAnswer.answer.slice(0, 60));

const proseAnswer = formatAnswer({
	type: 'completion',
	options: [],
	model: { text: '第一点。\n第二点。' }
});
check('简答题换行变成 <br>', proseAnswer.answer === '第一点。<br>第二点。', proseAnswer.answer);

const blanksAnswer = formatAnswer({ type: 'completion', options: [], model: { text: '80#443' } });
check('多空填空仍保留 # 分隔符', blanksAnswer.answer === '80#443' && blanksAnswer.mode === 'text', blanksAnswer.answer);

const skipAnswer = formatAnswer({ type: 'completion', options: [], model: { kind: 'skip', note: '需要截图' } });
check('模型主动 skip 时不产生答案', skipAnswer.answer === '' && skipAnswer.mode === 'skip', JSON.stringify(skipAnswer));

check('识别「要求截图」的题目', needsManualWork('运行程序截图，截图需包含源代码和运行结果') === true);
check('识别「画流程图」的题目', needsManualWork('请画出该算法的流程图') === true);
check('普通单选题不会被误判', needsManualWork('在个人理想与社会理想的关系上，下列论述不正确的是（ ）') === false);
check('说「贴源代码，不要截图」不算要截图', needsManualWork('贴源代码，不要截图。参考答案是截图。') === false);
check('只是提到「参考答案是截图」不算要截图', needsManualWork('参考答案是截图，请参考。') === false);
check('识别「如图」的图片题', looksLikeImageQuestion('如图所示的电路中，电流表读数是多少') === true);
check('普通题目不会被当成图片题', looksLikeImageQuestion('下列说法正确的是（ ）') === false);

// ---------------------------------------------------------------- HTTP 集成

section('2. 起服务（mock 模式）');

const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(PORT), '--mock'], {
	cwd: ROOT,
	env: {
		...process.env,
		OCS_TIKU_DATA_DIR: DATA_DIR,
		OCS_TIKU_CONFIG: path.join(DATA_DIR, 'config.json'),
		OCS_TIKU_MOCK: '1',
		OCS_TIKU_QUIET: '1'
	},
	// Windows 沙箱下带管道的 stdio 可能被拒绝（spawn EPERM），所以直接继承控制台输出
	stdio: ['ignore', 'inherit', 'inherit'],
	windowsHide: true
});

const serverLog = '（子进程输出已直接打印到控制台）';

async function waitForServer(timeoutMs = 15000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (child.exitCode !== null) throw new Error('服务启动失败：\n' + serverLog);
		try {
			const response = await fetch(`${BASE}/health`);
			if (response.ok) return await response.json();
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error('等待服务启动超时：\n' + serverLog);
}

async function postJson(pathname, body) {
	const response = await fetch(BASE + pathname, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	return { status: response.status, data: await response.json(), headers: response.headers };
}

try {
	const health = await waitForServer();
	check('/health 可用', health.ok === true && health.mock === true, JSON.stringify(health));

	const head = await fetch(`${BASE}/api/answer`, { method: 'HEAD' });
	check('HEAD /api/answer 返回 200（OCS 延迟探测）', head.status === 200, String(head.status));

	const preflight = await fetch(`${BASE}/api/answer`, {
		method: 'OPTIONS',
		headers: { Origin: 'https://mooc1.chaoxing.com', 'Access-Control-Request-Method': 'POST' }
	});
	check('CORS 预检放行任意来源', preflight.headers.get('access-control-allow-origin') === '*', String(preflight.headers.get('access-control-allow-origin')));
	check('预检声明 Private-Network', preflight.headers.get('access-control-allow-private-network') === 'true');

	const single = await postJson('/api/answer', {
		title: '下列哪个是 JavaScript 的基本数据类型？',
		options: 'A. number\nB. int\nC. float\nD. char',
		type: 'single'
	});
	check('单选答题成功', single.data.code === 1 && Boolean(single.data.answer), JSON.stringify(single.data));
	check('单选答案来自 DeepSeek（mock）', single.data.source === 'deepseek' && single.data.mock === true, single.data.source);
	check('单选返回选项原文', /^A\. number$/.test(single.data.answer), single.data.answer);

	const again = await postJson('/api/answer', {
		title: '下列哪个是 JavaScript 的基本数据类型？',
		options: 'A. number\nB. int\nC. float\nD. char',
		type: 'single'
	});
	check('同题第二次命中缓存', again.data.cached === true && again.data.source === 'cache', JSON.stringify(again.data));

	const titleNoise = await postJson('/api/answer', {
		title: '【单选题】下列哪个是 JavaScript 的基本数据类型？（ ）',
		options: 'A. number\nB. int\nC. float\nD. char',
		type: 'single'
	});
	check('题干带【单选题】/括号也能命中缓存', titleNoise.data.cached === true, JSON.stringify(titleNoise.data));

	const judgement = await postJson('/api/answer', {
		title: 'HTML 是编程语言。',
		options: 'A. 对\nB. 错',
		type: 'judgement'
	});
	check('判断题答案落在选项里', ['A. 对', 'B. 错'].includes(judgement.data.answer), judgement.data.answer);

	const multiple = await postJson('/api/answer', {
		title: '以下哪些属于前端技术？',
		options: 'A. HTML\nB. Java\nC. CSS\nD. Python',
		type: 'multiple'
	});
	check('多选答案用 # 连接', multiple.data.answer.includes('#'), multiple.data.answer);

	const completion = await postJson('/api/answer', {
		title: 'HTTP 默认端口是____，HTTPS 默认端口是____。',
		type: 'completion'
	});
	check('填空题答案用 # 连接', completion.data.code === 1 && completion.data.answer.includes('#'), JSON.stringify(completion.data));

	const getAnswer = await fetch(
		`${BASE}/api/answer?title=${encodeURIComponent('SQL 的全称是什么？')}&type=completion&options=`
	).then((response) => response.json());
	check('GET 方式答题可用', getAnswer.code === 1 && Boolean(getAnswer.answer), JSON.stringify(getAnswer));

	const missing = await postJson('/api/answer', { title: '', options: '', type: 'single' });
	check('空题干返回错误但 HTTP 仍是 200', missing.status === 200 && missing.data.code === 0, JSON.stringify(missing.data));

	// 默认配置下不该自动跳过任何题（关键词判断太容易误伤）
	const defaultSkip = await postJson('/api/answer', { title: '运行程序截图，截图需包含源代码和运行结果。', type: 'completion' });
	check('默认不自动跳过截图题', defaultSkip.data.skipped !== true, JSON.stringify(defaultSkip.data));

	// 手动打开开关后才跳过
	await postJson('/api/config', { skipManualWork: true, skipImageQuestions: true });

	const bankBeforeSkip = (await fetch(`${BASE}/api/stats`).then((response) => response.json())).entries ?? 0;
	const manualSkip = await postJson('/api/answer', {
		title: '运行程序截图，截图需包含源代码和运行结果。',
		type: 'completion'
	});
	check(
		'需要截图的题目直接留空',
		manualSkip.status === 200 && manualSkip.data.code === 0 && manualSkip.data.answer === '' && manualSkip.data.skipped === true,
		JSON.stringify(manualSkip.data)
	);
	const imageSkip = await postJson('/api/answer', {
		title: '如图所示的电路中，电流表的读数是多少？请说明理由。',
		type: 'completion'
	});
	check('带图的主观题直接留空', imageSkip.data.answer === '' && imageSkip.data.skipped === true, JSON.stringify(imageSkip.data));
	const bankAfterSkip = (await fetch(`${BASE}/api/stats`).then((response) => response.json())).entries ?? 0;
	check('跳过的题目不写入题库', bankAfterSkip === bankBeforeSkip, `before=${bankBeforeSkip} after=${bankAfterSkip}`);

	// 关键回归：题干里提到「截图」的选择题必须照常作答（不能整道大题被跳过）
	const choiceWithShot = await postJson('/api/answer', {
		title: '运行程序截图，截图需包含源代码和运行结果。定义字符数组，存储一个长度不多于10的字符串，则数组长度至少是',
		options: 'A. 12\nB. 11\nC. 10\nD. 9',
		type: 'single'
	});
	check(
		'选择题题干提到截图也照常作答',
		choiceWithShot.data.code === 1 && Boolean(choiceWithShot.data.answer) && choiceWithShot.data.skipped !== true,
		JSON.stringify(choiceWithShot.data)
	);

	// 关键回归：明确说「贴源代码，不要截图」的主观题要正常给答案
	const codeNotShot = await postJson('/api/answer', {
		title: '运行程序截图，截图需包含源代码和运行结果。贴源代码，不要截图。参考答案是截图。',
		type: 'completion'
	});
	check(
		'说「不要截图 / 贴源代码」的主观题照常作答',
		codeNotShot.data.code === 1 && codeNotShot.data.skipped !== true,
		JSON.stringify(codeNotShot.data)
	);

	section('3. 题库接口');

	const list = await fetch(`${BASE}/api/bank?size=50`).then((response) => response.json());
	check('题库已积累记录', list.total >= 5, `total=${list.total}`);

	const manual = await postJson('/api/bank', {
		title: '手工录入的测试题',
		type: 'single',
		options: 'A. 甲\nB. 乙',
		answer: 'B. 乙'
	});
	check('手工新增成功', manual.data.code === 1 && Boolean(manual.data.entry), JSON.stringify(manual.data).slice(0, 200));

	const manualAsk = await postJson('/api/answer', { title: '手工录入的测试题', options: 'A. 甲\nB. 乙', type: 'single' });
	check('手工题可直接命中且不调 AI', manualAsk.data.cached === true && manualAsk.data.answer === 'B. 乙', JSON.stringify(manualAsk.data));

	const stats = await fetch(`${BASE}/api/stats`).then((response) => response.json());
	check('统计有数据', stats.lookups > 0 && stats.hits > 0, JSON.stringify(stats));

	const exported = await fetch(`${BASE}/api/export?format=json`).then((response) => response.json());
	check(
		'导出 JSON 带 entries 数组',
		Array.isArray(exported.entries) && exported.entries.length > 0 && exported.count === exported.entries.length,
		`count=${exported.count} len=${exported.entries?.length}`
	);

	const reimported = await postJson('/api/import', { entries: exported.entries, mode: 'merge' });
	check('导出的 JSON 能原样导回', reimported.data.code === 1, JSON.stringify(reimported.data).slice(0, 160));

	const csv = await fetch(`${BASE}/api/export?format=csv`).then((response) => response.text());
	check('导出 CSV 带表头', csv.includes('题目') && csv.includes('答案'), csv.slice(0, 40));

	const removed = await fetch(`${BASE}/api/bank/${encodeURIComponent(manual.data.entry.id)}`, { method: 'DELETE' }).then((response) =>
		response.json()
	);
	check('删除单条成功', removed.code === 1, JSON.stringify(removed));

	const imported = await postJson('/api/import', {
		entries: [{ title: '导入的题目', type: 'judgement', answer: '对' }],
		mode: 'merge'
	});
	check('导入接口可用', imported.data.code === 1 && imported.data.added >= 1, JSON.stringify(imported.data));

	const page = await fetch(`${BASE}/`).then((response) => response.text());
	check('管理台首页可访问', page.includes('OCS DeepSeek 题库'), String(page.length));

	const cleared = await postJson('/api/bank', { all: true });
	check('清空题库可用', cleared.data.code === 1, JSON.stringify(cleared.data));
} catch (error) {
	failed++;
	failures.push(error.message);
	console.log(`\n\x1b[31m运行出错：${error.message}\x1b[0m`);
	if (serverLog) console.log('\n--- 服务日志 ---\n' + serverLog.slice(-2000));
} finally {
	child.kill();
	await new Promise((resolve) => setTimeout(resolve, 300));
	try {
		fs.rmSync(DATA_DIR, { recursive: true, force: true });
	} catch {}
}

console.log(`\n\x1b[1m结果：${passed} 通过，${failed} 失败\x1b[0m`);
if (failed) {
	console.log('\n失败项：');
	for (const item of failures) console.log(' - ' + item);
	process.exit(1);
}
console.log('全部通过 ✅');
