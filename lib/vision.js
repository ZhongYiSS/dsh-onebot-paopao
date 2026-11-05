/**
 * 识图辅助：① 本地 OCR（NapCat 的 ocr_image，零成本、只认文字）；
 * ② 视觉模型描述（OpenAI 兼容的 chat/completions，需要配置模型名与 key）。
 * 两者都只产出「一段短文本」，拼进 [图片:路径] 的注解里给模型看。
 * @module dsh-onebot/vision
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/**
 * 取视觉模型的 key：先看环境变量，再退回 DSH 的 ~/.dsh/.credentials.yaml 里的 refs。
 * DSH 的 key 存在 credentials 里、不一定注入子进程环境，所以两条都试。
 * @param envName - 环境变量名（空则用 APIGOTO_API_KEY）。
 * @returns key 字符串；都没有返回 ''。
 */
export function resolveApiKey(envName) {
    const name = typeof envName === 'string' && envName !== '' ? envName : 'APIGOTO_API_KEY';
    const fromEnv = process.env[name];
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '')
        return fromEnv.trim();
    try {
        const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = new RegExp('^\\s*' + escaped + ':\\s*(\\S+)\\s*$', 'm').exec(text);
        if (match !== null)
            return match[1].replace(/^['"]|['"]$/g, '');
    }
    catch {
        // 没有这个文件就当作没配；上层会回落到 OCR。
    }
    return '';
}
/** 图片魔数 → mime（够用就行）。 */
export function imageMime(buffer) {
    if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50)
        return 'image/png';
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8)
        return 'image/jpeg';
    if (buffer.length >= 6 && buffer[0] === 0x47 && buffer[1] === 0x49)
        return 'image/gif';
    if (buffer.length >= 12 && buffer.subarray(8, 12).toString('ascii') === 'WEBP')
        return 'image/webp';
    return 'image/jpeg';
}
/**
 * 用 NapCat 的 ocr_image 认图里的字。
 * @param call - 连接调用（OneBot action, params）。
 * @param buffer - 图片字节。
 * @returns 识别出的文字（多行合并成一行、截断），没认出来返回 ''。
 */
export async function ocrText(call, buffer) {
    const data = await call('ocr_image', { image: 'base64://' + buffer.toString('base64') });
    const texts = [];
    const collect = (value) => {
        if (typeof value === 'string') {
            if (value.trim() !== '')
                texts.push(value.trim());
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value)
                collect(item);
            return;
        }
        if (value !== null && typeof value === 'object') {
            const record = value;
            for (const key of ['text', 'texts', 'result', 'results', 'data'])
                if (record[key] !== undefined)
                    collect(record[key]);
        }
    };
    collect(data);
    const joined = texts.join(' ').replace(/\s+/g, ' ').trim();
    return joined.length > 200 ? joined.slice(0, 200) + '…' : joined;
}
/**
 * 让视觉模型看一眼图：返回一句中文描述；没配置或失败返回 ''。
 * @param buffer - 图片字节。
 * @param options - baseURL / model / apiKey / timeoutMs / prompt。
 * @returns 描述文本。
 */
export async function describeImage(buffer, options) {
    const { baseURL, model, apiKey } = options;
    if (baseURL === '' || model === '' || apiKey === '') {
        // 以前这里静默返回 ''，结果「识图死了」能藏一整天（2026-11-05 踩过）。
        throw new Error('视觉模型没配全：baseURL/model/apiKey 有一个是空的（model=' + model + '，key=' + (apiKey === '' ? '空' : '有') + '）');
    }
    // 有些模型（Sage-A1.5 / Agents-A1）先想再说，200 个 token 全被思考吃掉、
    // 正文一个字不剩。实测 3000 够用（表情包/截图都过），可用 options.maxTokens 覆盖。
    const maxTokens = Number(options.maxTokens) > 0 ? Number(options.maxTokens) : 3000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    try {
        const response = await fetch(baseURL.replace(/\/$/, '') + '/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
            body: JSON.stringify({
                model,
                max_tokens: maxTokens,
                messages: [{
                        role: 'user',
                        content: (buffer === null || buffer === undefined)
                            ? [{ type: 'text', text: options.prompt ?? '' }]
                            : [
                                { type: 'text', text: options.prompt ?? '用中文一句话说清这张图的内容：画的是什么、大概什么场景、图里有没有文字（有就把文字念出来）。40 字以内，别客套。' },
                                { type: 'image_url', image_url: { url: 'data:' + imageMime(buffer) + ';base64,' + buffer.toString('base64'), detail: options.detail ?? 'low' } },
                            ],
                    }],
            }),
            signal: controller.signal,
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            // 带上状态码和前 120 字，拉黑/额度用完/模型下线一眼分得清。
            throw new Error('HTTP ' + response.status + (detail ? ': ' + detail.replace(/\s+/g, ' ').slice(0, 120) : ''));
        }
        const payload = await response.json();
        const content = payload?.choices?.[0]?.message?.content;
        const text = typeof content === 'string'
            ? content
            : Array.isArray(content) ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join(' ') : '';
        const clean = text.replace(/\s+/g, ' ').trim();
        if (clean === '') {
            // 思考型模型常见：max_tokens 用光了（finish_reason=length）。记下来，别装成功。
            options.log?.('warn', '视觉模型返回空正文（' + model + '，finish=' + (payload?.choices?.[0]?.finish_reason ?? '?')
                + '，思考 ' + (payload?.usage?.reasoning_tokens ?? 0) + ' tokens，上限 ' + maxTokens + '）');
            return '';
        }
        const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : 200;
        return clean.length > maxChars ? clean.slice(0, maxChars) + '…' : clean;
    }
    finally {
        clearTimeout(timer);
    }
}
