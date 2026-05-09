import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getOPFSDirectory, writeToOPFS } from './index';

describe('OPFS Utilities', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn(),
      },
    });
  });

  it('getOPFSDirectory should call navigator.storage.getDirectory', async () => {
    const mockHandle = {};
    (navigator.storage.getDirectory as any).mockResolvedValue(mockHandle);

    const result = await getOPFSDirectory();
    expect(navigator.storage.getDirectory).toHaveBeenCalled();
    expect(result).toBe(mockHandle);
  });

  it('writeToOPFS should pipe stream to writable', async () => {
    const mockWritable = {
      pipeTo: vi.fn().mockResolvedValue(undefined),
    };
    const mockFileHandle = {
      createWritable: vi.fn().mockResolvedValue(mockWritable),
    };
    const mockRoot = {
      getFileHandle: vi.fn().mockResolvedValue(mockFileHandle),
    };

    (navigator.storage.getDirectory as any).mockResolvedValue(mockRoot);

    const mockStream = {
      pipeTo: vi.fn().mockResolvedValue(undefined),
    };

    await writeToOPFS('test.txt', mockStream as any);

    expect(mockRoot.getFileHandle).toHaveBeenCalledWith('test.txt', { create: true });
    expect(mockFileHandle.createWritable).toHaveBeenCalled();
    expect(mockStream.pipeTo).toHaveBeenCalledWith(mockWritable);
  });
});
