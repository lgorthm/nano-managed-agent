import { describe, expect, it } from 'vitest';
import { FALLBACK_MIME_TYPE, mimeTypeFromPath } from '../../src/file/mime';

describe('mimeTypeFromPath', () => {
  it('常见扩展名映射到对应 media type', () => {
    expect(mimeTypeFromPath('report.md')).toBe('text/markdown');
    expect(mimeTypeFromPath('data.csv')).toBe('text/csv');
    expect(mimeTypeFromPath('result.json')).toBe('application/json');
    expect(mimeTypeFromPath('events.jsonl')).toBe('application/jsonl');
    expect(mimeTypeFromPath('chart.png')).toBe('image/png');
    expect(mimeTypeFromPath('photo.JPG')).toBe('image/jpeg');
    expect(mimeTypeFromPath('plot.svg')).toBe('image/svg+xml');
    expect(mimeTypeFromPath('paper.pdf')).toBe('application/pdf');
    expect(mimeTypeFromPath('bundle.tar.gz')).toBe('application/gzip');
    expect(mimeTypeFromPath('main.py')).toBe('text/x-python');
  });

  it('按 basename 解析,目录段中的点不参与', () => {
    expect(mimeTypeFromPath('reports/v1.2/summary.txt')).toBe('text/plain');
    expect(mimeTypeFromPath('a.b/c')).toBe(FALLBACK_MIME_TYPE);
  });

  it('无扩展名、收尾点与隐藏文件回退 octet-stream', () => {
    expect(mimeTypeFromPath('Makefile')).toBe(FALLBACK_MIME_TYPE);
    expect(mimeTypeFromPath('archive.')).toBe(FALLBACK_MIME_TYPE);
    expect(mimeTypeFromPath('.bashrc')).toBe(FALLBACK_MIME_TYPE);
  });

  it('未知扩展名回退 octet-stream', () => {
    expect(mimeTypeFromPath('data.unknownext')).toBe(FALLBACK_MIME_TYPE);
  });
});
