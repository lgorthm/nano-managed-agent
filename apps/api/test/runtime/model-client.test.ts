/**
 * streamChatCompletion 的协议级单测:不经过 DO / 路由,直连 node 侧 mock 上游,
 * 聚焦 SSE 分片解析。核心回归:真实上游(OpenAI 兼容实现)的工具调用续块以
 * JSON null 携带 name,累积逻辑若用宽松守卫会让 null 覆盖首块已到位的工具名,
 * 下游表现为 Unknown tool "null"(模型重试三次全部失败)。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type ChatModelConfig,
  ModelHttpError,
  streamChatCompletion,
} from '../../src/runtime/model-client';
import { enqueueModelScript, resetModelMock } from '../mock-model/client';

const CONFIG: ChatModelConfig = {
  baseUrl: 'http://127.0.0.1:18234',
  apiKey: 'test-model-key',
  model: 'fragment-parse-test',
  gatewayId: 'test-gateway',
};

beforeEach(() => resetModelMock());

describe('工具调用分片累积', () => {
  it('续块的 name:null 不覆盖首块工具名,arguments 分片按 index 重组', async () => {
    await enqueueModelScript({
      match: 'fragment-parse-test',
      chunks: [{ reasoning_content: 'thinking' }, { content: 'msg' }],
      tool_calls: [
        { name: 'bash', arguments: JSON.stringify({ command: 'echo hi' }) },
        { name: 'ls', arguments: '{}' },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7, cached_tokens: 3 },
    });

    const result = await streamChatCompletion(CONFIG, [{ role: 'user', content: 'go' }], {
      onDelta: () => {},
    });

    expect(result.thinking).toBe('thinking');
    expect(result.message).toBe('msg');
    expect(result.usage).toEqual({
      input_tokens: 11,
      output_tokens: 7,
      cache_read_input_tokens: 3,
    });
    // mock 把每个调用的 arguments 一分为二、续块 name 置 null:重组必须无损
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]).toMatchObject({
      id: 'call_mock_0',
      name: 'bash',
    });
    expect(result.toolCalls[0]!.arguments).toBe(JSON.stringify({ command: 'echo hi' }));
    expect(result.toolCalls[1]).toMatchObject({
      id: 'call_mock_1',
      name: 'ls',
    });
    expect(result.toolCalls[1]!.arguments).toBe('{}');
  });

  it('上游非 2xx 抛 ModelHttpError(不重试的 4xx)', async () => {
    await enqueueModelScript({
      match: 'fragment-parse-test',
      status: 400,
      chunks: [],
    });
    await expect(
      streamChatCompletion(CONFIG, [{ role: 'user', content: 'go' }], {
        onDelta: () => {},
      }),
    ).rejects.toBeInstanceOf(ModelHttpError);
  });
});
