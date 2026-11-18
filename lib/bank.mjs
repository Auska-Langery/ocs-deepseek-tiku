/**
 * 本地题库（答案缓存）存储。
 * 数据结构就是 data/bank.json，一条记录一道题；
 * OCS 每次查题先查这里，命中就直接返回，没命中才调用 DeepSeek 并把结果写回来。
 */

import fs from 'node:fs';
import path from 'node:path';

import { normalizeText, questionKey, shortId, stripQuestionNoise } from './text.mjs';

const FILE_VERSION = 1;
const MAX_ENTRIES = 50000;

export class Bank {
	constructor(dataDir) {
		this.dataDir = dataDir;
		this.file = path.join(dataDir, 'bank.json');
		/** @type {any[]} */
		this.entries = [];
		/** @type {Map<string, any>} */
		this.byKey = new Map();
		/** @type {Map<string, any[]>} */
		this.byNorm = new Map();
		this.dirty = false;
		this.timer = null;
		this.counters = { lookups: 0, hits: 0, misses: 0, aiCalls: 0, aiFailures: 0 };
	}

	init() {
		fs.mkdirSync(this.dataDir, { recursive: true });
		if (!fs.existsSync(this.file)) {
			this.entries = [];
			return this;
		}
		try {
			const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
			this.entries = Array.isArray(data?.entries) ? data.entries : Array.isArray(data) ? data : [];
		} catch (error) {
			// 文件损坏时先备份，避免直接覆盖用户数据
			const backup = `${this.file}.broken-${Date.now()}`;
			try {
				fs.renameSync(this.file, backup);
			} catch {}
			this.entries = [];
			console.warn(`⚠️  bank.json 解析失败（${error.message}），已备份为 ${path.basename(backup)}`);
		}
		this.entries = this.entries.filter((item) => item && item.title && item.key);
		const removed = this.#prune();
		if (removed) {
			// 启动时清理掉脏数据要立刻落盘，否则进程被杀时又会带回来
			this.dirty = true;
			this.flush();
			console.log(`🧹 已清理 ${removed} 条历史脏数据（旧答案 / 题型未知的重复条目）`);
		}
		this.#reindex();
		return this;
	}

	/**
	 * 清理历史脏数据（旧版本或模型抽风留下的），返回删除条数。
	 * 规则：
	 *  1. 题型未知（unknown）的条目直接删 —— 旧版本会给同一道题另存一份
	 *     unknown 答案，内容普遍很差（例如 "2#错误#A#void turn(...)"）；
	 *  2. 空答案 / 只有分隔符（如 "#"）的条目删；
	 *  3. 代码类答案里没有换行的（旧版本没转 HTML），删掉让模型重答，
	 *     否则 1.1.0 修好的换行又会被旧缓存顶掉。
	 */
	#prune() {
		const before = this.entries.length;
		const drop = new Set();
		for (const entry of this.entries) {
			// 旧版本在题型未知时会另存一份答案，内容普遍很差（还常和正确题型重复），统一清掉
			if (!entry.type || entry.type === 'unknown') {
				drop.add(entry);
				continue;
			}
			const answer = String(entry.answer ?? '').trim();
			if (!answer || !answer.replace(/[#\s]/g, '')) {
				drop.add(entry);
				continue;
			}
			const looksLikeCode = /#include|int\s+main|printf\s*\(|def\s+\w+\(/.test(answer);
			if (looksLikeCode && !answer.includes('<br>') && !answer.includes('\n')) drop.add(entry);
		}
		if (!drop.size) return 0;
		this.entries = this.entries.filter((entry) => !drop.has(entry));
		return before - this.entries.length;
	}

	/**
	 * 删掉「代码类答案但没有换行标记」的旧缓存（1.0 版本留下的），返回删除条数。
	 * 只在 htmlAnswer 开启时调用 —— 关掉 HTML 的用户本来就想要纯文本。
	 */
	pruneLegacyTextAnswers() {
		const before = this.entries.length;
		this.entries = this.entries.filter((entry) => {
			if (entry.type !== 'completion') return true;
			const answer = String(entry.answer ?? '');
			const looksLikeCode = /#include|int\s+main|printf\s*\(|def\s+\w+\(/.test(answer);
			return !(looksLikeCode && !answer.includes('<br>'));
		});
		const removed = before - this.entries.length;
		if (removed) {
			this.dirty = true;
			this.flush();
			this.#reindex();
		}
		return removed;
	}

	#reindex() {		this.byKey.clear();
		this.byNorm.clear();
		for (const entry of this.entries) {
			this.byKey.set(entry.key, entry);
			const norm = entry.titleNorm || normalizeText(stripQuestionNoise(entry.title));
			if (!this.byNorm.has(norm)) this.byNorm.set(norm, []);
			this.byNorm.get(norm).push(entry);
		}
	}

	/** 精确命中：同题型 + 同题干 */
	get(key) {
		return this.byKey.get(key);
	}

	/**
	 * 同题干、不同题型（例如同一道题一次以单选、一次以多选题出现）的候选记录。
	 * 用于“题干一样但题型标记不同”时复用答案。
	 */
	candidates(titleNorm, type) {
		const list = this.byNorm.get(titleNorm) || [];
		if (!list.length) return [];
		return list.slice().sort((a, b) => {
			const scoreA = a.type === type ? 0 : 1;
			const scoreB = b.type === type ? 0 : 1;
			if (scoreA !== scoreB) return scoreA - scoreB;
			return (b.hits || 0) - (a.hits || 0);
		});
	}

	/** 写入/更新一条记录（key 相同则覆盖） */
	upsert(entry) {
		const existing = entry.key ? this.byKey.get(entry.key) : undefined;
		if (existing) {
			Object.assign(existing, entry, { id: existing.id, createdAt: existing.createdAt || entry.createdAt });
			existing.updatedAt = new Date().toISOString();
			existing.hits = existing.hits || 0;
			this.#markDirty();
			return existing;
		}
		const record = {
			id: entry.id || shortId(),
			createdAt: entry.createdAt || new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			hits: entry.hits || 0,
			...entry
		};
		this.entries.push(record);
		this.byKey.set(record.key, record);
		const norm = record.titleNorm || normalizeText(stripQuestionNoise(record.title));
		if (!this.byNorm.has(norm)) this.byNorm.set(norm, []);
		this.byNorm.get(norm).push(record);
		if (this.entries.length > MAX_ENTRIES) {
			const removed = this.entries.splice(0, this.entries.length - MAX_ENTRIES);
			for (const item of removed) this.byKey.delete(item.key);
			this.#reindex();
		}
		this.#markDirty();
		return record;
	}

	/** 命中一次：累加命中数并更新最后命中时间 */
	touch(entry, answer, extra = {}) {
		if (!entry) return entry;
		entry.hits = (entry.hits || 0) + 1;
		entry.lastHitAt = new Date().toISOString();
		if (answer) entry.answer = answer;
		Object.assign(entry, extra);
		this.#markDirty();
		return entry;
	}

	remove(id) {
		const index = this.entries.findIndex((item) => item.id === id);
		if (index === -1) return false;
		const [removed] = this.entries.splice(index, 1);
		this.byKey.delete(removed.key);
		this.#reindex();
		this.#markDirty();
		return true;
	}

	clear() {
		const count = this.entries.length;
		this.entries = [];
		this.byKey.clear();
		this.byNorm.clear();
		this.#markDirty();
		return count;
	}

	list({ q = '', type = '', page = 1, size = 20, sort = 'updated' } = {}) {
		let items = this.entries;
		if (type) items = items.filter((item) => item.type === type);
		const keyword = normalizeText(q);
		if (keyword) {
			items = items.filter(
				(item) =>
					normalizeText(item.title).includes(keyword) ||
					normalizeText(item.answer).includes(keyword) ||
					normalizeText(item.text).includes(keyword)
			);
		}
		items = items.slice();
		if (sort === 'hits') items.sort((a, b) => (b.hits || 0) - (a.hits || 0));
		else if (sort === 'created') items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
		else items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

		const total = items.length;
		const pageSize = Math.max(1, Math.min(200, Number(size) || 20));
		const current = Math.max(1, Number(page) || 1);
		const start = (current - 1) * pageSize;
		return {
			total,
			page: current,
			size: pageSize,
			pages: Math.max(1, Math.ceil(total / pageSize)),
			items: items.slice(start, start + pageSize).map((entry) => ({
				id: entry.id,
				title: entry.title,
				type: entry.type,
				answer: entry.answer,
				letters: entry.letters,
				picked: entry.picked,
				source: entry.source,
				confidence: entry.confidence,
				note: entry.note,
				hits: entry.hits,
				model: entry.model,
				createdAt: entry.createdAt,
				updatedAt: entry.updatedAt,
				lastHitAt: entry.lastHitAt
			}))
		};
	}

	stats() {
		const byType = {};
		let withAnswer = 0;
		for (const entry of this.entries) {
			byType[entry.type || 'unknown'] = (byType[entry.type || 'unknown'] || 0) + 1;
			if (entry.answer) withAnswer++;
		}
		const lookups = this.counters.lookups;
		return {
			total: this.entries.length,
			withAnswer,
			byType,
			hitRate: lookups ? Math.round((this.counters.hits / lookups) * 1000) / 10 : 0,
			lookups,
			hits: this.counters.hits,
			misses: this.counters.misses,
			aiCalls: this.counters.aiCalls,
			aiFailures: this.counters.aiFailures
		};
	}

	/** 导出全部记录 */
	exportEntries() {
		return {
			version: FILE_VERSION,
			app: 'ocs-deepseek-tiku',
			exportedAt: new Date().toISOString(),
			count: this.entries.length,
			entries: this.entries
		};
	}

	toCSV() {
		const header = ['题目', '题型', '答案', '来源', '置信度', '命中次数', '模型', '最后命中', '更新时间'];
		const rows = this.entries.map((entry) => [
			entry.title,
			entry.type,
			entry.answer,
			entry.source,
			entry.confidence ?? '',
			entry.hits ?? 0,
			entry.model ?? '',
			entry.lastHitAt ?? '',
			entry.updatedAt ?? ''
		]);
		const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
		return '\uFEFF' + [header, ...rows].map((row) => row.map(escape).join(',')).join('\r\n');
	}

	/** 导入（merge 覆盖同名题，replace 先清空） */
	importEntries(payload, mode = 'merge') {
		const raw = Array.isArray(payload) ? payload : Array.isArray(payload?.entries) ? payload.entries : [];
		if (!raw.length) throw new Error('导入内容为空或格式不是题库 JSON');
		if (mode === 'replace') this.clear();

		let added = 0;
		let updated = 0;
		for (const item of raw) {
			const title = String(item?.title ?? item?.question ?? '').trim();
			if (!title) continue;
			const type = String(item?.type ?? 'unknown');
			const key = item?.key || questionKey(title, type);
			const entry = {
				key,
				title,
				titleNorm: item.titleNorm || normalizeText(stripQuestionNoise(title)),
				type,
				typeRaw: item.typeRaw || type,
				options: Array.isArray(item.options) ? item.options : [],
				optionCount: item.optionCount ?? (Array.isArray(item.options) ? item.options.length : 0),
				letters: Array.isArray(item.letters) ? item.letters : [],
				picked: Array.isArray(item.picked) ? item.picked : [],
				answer: String(item.answer ?? ''),
				text: item.text ?? '',
				mode: item.mode ?? 'option',
				confidence: item.confidence ?? 0,
				note: item.note ?? '',
				source: item.source || 'manual',
				model: item.model ?? '',
				hits: Number(item.hits) || 0,
				createdAt: item.createdAt || new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				lastHitAt: item.lastHitAt || null
			};
			if (this.byKey.has(key)) updated++;
			else added++;
			this.upsert(entry);
		}
		return { added, updated, total: this.entries.length };
	}

	#markDirty() {
		this.dirty = true;
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.flush();
		}, 400);
	}

	/** 落盘（原子写） */
	flush() {
		if (!this.dirty) return;
		this.dirty = false;
		const payload = {
			version: FILE_VERSION,
			app: 'ocs-deepseek-tiku',
			updatedAt: new Date().toISOString(),
			count: this.entries.length,
			entries: this.entries
		};
		const tmp = `${this.file}.tmp`;
		try {
			fs.mkdirSync(this.dataDir, { recursive: true });
			fs.writeFileSync(tmp, JSON.stringify(payload, null, '\t'), 'utf8');
			fs.renameSync(tmp, this.file);
		} catch (error) {
			console.error(`保存题库失败：${error.message}`);
		}
	}
}
