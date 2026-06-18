// API Base URL — reads from environment, falls back to localhost dev server
export const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string) || 'http://127.0.0.1:8000';

export const API_V1 = `${API_BASE_URL}/api/v1`;
