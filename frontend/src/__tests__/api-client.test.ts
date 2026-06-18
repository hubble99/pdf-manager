import apiClient, { checkHealth } from '../api/client';
import { describe, it, expect, vi } from 'vitest';

describe('API Client', () => {
  it('has correct baseURL', () => {
    expect(apiClient.defaults.baseURL).toBeDefined();
    // Default baseURL in config is http://127.0.0.1:8000
    expect(apiClient.defaults.baseURL).toContain('8000');
  });

  it('checkHealth returns true on success', async () => {
    const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ data: { status: 'success' } });
    const result = await checkHealth();
    expect(result).toBe(true);
    expect(getSpy).toHaveBeenCalledWith('/health', undefined);
    getSpy.mockRestore();
  });

  it('checkHealth returns false on failure', async () => {
    const getSpy = vi.spyOn(apiClient, 'get').mockRejectedValueOnce(new Error('Network Error'));
    const result = await checkHealth();
    expect(result).toBe(false);
    expect(getSpy).toHaveBeenCalledWith('/health', undefined);
    getSpy.mockRestore();
  });

  it('response interceptor normalizes error response message', async () => {
    const errorResponse = {
      response: {
        data: {
          message: 'Database connection failed',
        },
      },
    };

    // We pass a custom adapter that rejects to trigger the interceptor
    await expect(
      apiClient.get('/test-error-1', {
        adapter: () => Promise.reject(errorResponse),
      })
    ).rejects.toThrow('Database connection failed');
  });

  it('response interceptor falls back to detail', async () => {
    const errorResponse = {
      response: {
        data: {
          detail: 'Invalid path specified',
        },
      },
    };

    await expect(
      apiClient.get('/test-error-2', {
        adapter: () => Promise.reject(errorResponse),
      })
    ).rejects.toThrow('Invalid path specified');
  });

  it('response interceptor falls back to error.message', async () => {
    const errorNoResponse = {
      message: 'Connection timed out',
    };

    await expect(
      apiClient.get('/test-error-3', {
        adapter: () => Promise.reject(errorNoResponse),
      })
    ).rejects.toThrow('Connection timed out');
  });
});
