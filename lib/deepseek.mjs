/**
 * DeepSeek 调用封装：并发控制、超时、重试、模型回退、mock 模式。
 * 只用 Node 内置 fetch（Node 18+）。
 */

import { buildMessages } from './answer.mjs';
import { parseOptions } from './text.mjs';

export class ModelNotFoundError extends Error {
	constructor(model, detail) {
		super(`模型 ${model} 不可用${detail ? `：${detail}` : ''}`);
		this.name = 'ModelNotFoundError';
		this.model = model;
	}
}

export class RetryableError extends Error {
	constructor(message) {
		super(message);
		this.name = 'RetryableError';
	}
}

/** 简单信号量 */
class Semaphore {
	constructor(limit) {
		this.limit = Math.max(1, limit);
		this.active = 0;
		this.queue = [];
	}

	async acquire() {
		if (this.active < this.limit) {
			this.active++;
			return;
		}
		await new Promise((resolve) => this.queue.push(resolve));
		this.active++;
	}

	release() {
		this.active = Math.max(0, this.active - 1);
		const next = this.queue.shift();
		if (next) next();
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class DeepSeekClient {
	/**
	 * @param {() => any} getConfig 返回当前配置的函数（配置热更新后立即生效）
	 */
	constructor(getConfig) {
		this.getConfig = getConfig;
		this.limit = 4;
		this.semaphore = new Semaphore(this.limit);
		/** 上次成功的模型，优先使用，避免每次都回退 */
		this.activeModel = '';
		this.lastError = '';
	}

	async ask({ title, type, options, hint, wholeQuestion }) {
		const config = this.getConfig();
		if (config.mock) {
			return this.#mock({ title, type, options });
		}
		if (!config.apiKey) {
			throw new Error('尚未配置 DeepSeek API Key：打开题库管理页填写并保存后即可使用');
		}

		this.#syncLimit(config.concurrency);
		const messages = buildMessages({ title, type, options, hint, wholeQuestion, codeLanguage: config.codeLanguage });
		const chain = this.#modelChain(config);
		const attempts = config.attempts;
		let lastError;

		await this.semaphore.acquire();
		const started = Date.now();
		// 输出被 max_tokens 截断时，自动加大预算重试一次，避免整题白跑
		let budget = config.maxTokens;
		try {
			for (let attempt = 0; attempt < attempts; attempt++) {
				for (const model of chain) {
					try {
						const result = await this.#request({ model, messages, config, maxTokens: budget });
						this.activeModel = model;
						this.lastError = '';
						return { ...result, ms: Date.now() - started, attempts: attempt + 1 };
					} catch (error) {
						lastError = error;
						this.lastError = error.message;
						if (error instanceof ModelNotFoundError) {
							// 当前模型不可用，直接换下一个
							continue;
						}
						if (error?.code === 'TRUNCATED' && budget < 8192) {
							budget = Math.min(8192, budget * 2);
							continue;
						}
						break;
					}
				}
				if (attempt + 1 < attempts && !(lastError instanceof ModelNotFoundError)) {
					await sleep(500 * (attempt + 1));
				}
			}
		} finally {
			this.semaphore.release();
		}

		throw lastError ?? new Error('DeepSeek 调用失败');
	}

	#syncLimit(limit) {
		if (limit && limit !== this.limit) {
			this.limit = limit;
			this.semaphore.limit = limit;
		}
	}

	#modelChain(config) {
		const models = [];
		if (this.activeModel) models.push(this.activeModel);
		models.push(config.model, ...(config.fallbackModels || []));
		return [...new Set(models.filter(Boolean))];
	}

	async #request({ model, messages, config, maxTokens }) {
		const url = `${config.baseUrl}/chat/completions`;
		const body = {
			model,
			messages,
			stream: false,
			temperature: config.temperature,
			max_tokens: maxTokens ?? config.maxTokens,
			response_format: { type: 'json_object' }
		};
		if (config.thinking === 'enabled') {
			body.thinking = { type: 'enabled' };
			body.reasoning_effort = 'low';
		}

		let response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${config.apiKey}`
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(config.timeoutSeconds * 1000)
			});
		} catch (error) {
			if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
				throw new RetryableError(`DeepSeek 请求超时（${config.timeoutSeconds} 秒），可调大 config.json 的 timeoutSeconds`);
			}
			throw new RetryableError(`无法连接 DeepSeek（${error?.message || '网络错误'}），请检查网络/代理或 baseUrl`);
		}

		const text = await response.text();
		let data;
		try {
			data = text ? JSON.parse(text) : null;
		} catch {
			data = null;
		}

		if (!response.ok) {
			const detail =
				data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || data?.message || text.slice(0, 200);
			if (response.status === 401) throw new Error('API Key 无效或已过期（HTTP 401），请重新填写');
			if (response.status === 402) throw new Error('DeepSeek 账户余额不足（HTTP 402），请充值后再用');
			if (response.status === 404) {
				if (/model/i.test(detail)) throw new ModelNotFoundError(model, detail);
				throw new Error(`接口地址可能不正确（HTTP 404）：${config.baseUrl}`);
			}
			if (response.status === 429) throw new RetryableError('请求过于频繁（HTTP 429），请稍后重试或调小并发');
			if (/model/i.test(detail) && (response.status === 400 || response.status === 404)) {
				throw new ModelNotFoundError(model, detail);
			}
			if (response.status >= 500) throw new RetryableError(`DeepSeek 服务异常（HTTP ${response.status}）：${detail}`);
			throw new Error(`DeepSeek 返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`);
		}

		const choice = data?.choices?.[0];
		if (!choice) throw new RetryableError('DeepSeek 返回内容为空（没有 choices）');
		if (choice.finish_reason === 'length') {
			// 交给上层自动加大 max_tokens 重试；仍然截断时提示用户
			const error = new RetryableError('DeepSeek 输出被截断（达到 max_tokens），可在 config.json 调大 maxTokens');
			error.code = 'TRUNCATED';
			throw error;
		}
		const content = choice.message?.content;
		if (!content) throw new RetryableError('DeepSeek 返回空内容');

		return { content, raw: content, usage: data.usage ?? null, model, finishReason: choice.finish_reason };
	}

	/** 列出可用模型，用于“测试连接” */
	async listModels() {
		const config = this.getConfig();
		if (config.mock) return { ok: true, models: ['mock-model'], ms: 0 };
		if (!config.apiKey) throw new Error('尚未配置 API Key');
		const started = Date.now();
		const response = await fetch(`${config.baseUrl}/models`, {
			headers: { Authorization: `Bearer ${config.apiKey}` },
			signal: AbortSignal.timeout(15000)
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`获取模型列表失败（HTTP ${response.status}）：${text.slice(0, 200)}`);
		}
		let models = [];
		try {
			const data = JSON.parse(text);
			models = (data?.data ?? []).map((item) => item.id).filter(Boolean);
		} catch {
			models = [];
		}
		return { ok: true, models, ms: Date.now() - started };
	}

	/** 用一道小题真实跑一次，验证 Key / 模型 / 网络 */
	async testConnection() {
		if (this.getConfig().mock) {
			return { ok: true, model: 'mock-model', answer: 'A', ms: 1, mock: true };
		}
		const started = Date.now();
		const result = await this.ask({
			title: '1+1 等于几？',
			type: 'single',
			options: parseOptions('A. 2\nB. 3\nC. 4\nD. 5')
		});
		return { ok: true, model: result.model, answer: result.content, ms: Date.now() - started };
	}

	/** mock 模式：让没有 Key 的时候也能演示与自检 */
	#mock({ title, type, options }) {
		const opts = Array.isArray(options) ? options : [];
		const letters = [];
		if (type === 'completion' || !opts.length) {
			// 按题干里的空位数量生成 “答案1#答案2”，顺带验证多空格式
			const blanks = String(title ?? '').match(/_{2,}|（\s*）|\(\s*\)/g) ?? [];
			const count = Math.min(Math.max(blanks.length, 1), 6);
			const text = Array.from({ length: count }, (_, index) => `答案${index + 1}`).join('#');
			return {
				content: JSON.stringify({ kind: 'completion', letters: [], text, confidence: 0.9, note: 'mock 模式' }),
				raw: '',
				usage: null,
				model: 'mock-model',
				ms: 12,
				attempts: 1,
				mock: true
			};
		}
		letters.push(opts[0]?.letter ?? 'A');
		if (type === 'multiple' && opts.length >= 3) letters.push(opts[2].letter);
		const payload = {
			kind: type === 'judgement' ? 'judgement' : type === 'multiple' ? 'multiple' : 'single',
			letters,
			text: '',
			confidence: 0.99,
			note: `mock 模式：题干长度 ${String(title ?? '').length}`
		};
		return {
			content: JSON.stringify(payload),
			raw: '',
			usage: null,
			model: 'mock-model',
			ms: 12,
			attempts: 1,
			mock: true
		};
	}
}
