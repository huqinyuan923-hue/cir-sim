/**
 * 文件下载 / 上传 / localStorage 自动保存（M5）
 * DOM 交互集中在此层，全部通过注入解耦以便测试；
 * 默认实现走浏览器全局（Blob + URL + FileReader + localStorage），零第三方依赖。
 */

import type { Netlist } from '../contract.js';
import { serializeNetlist, parseNetlist, ARCHIVE_EXT } from './serialize.js';

/** 下载环境抽象（测试注入桩） */
export interface DownloadEnv {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  /** 创建临时 <a> 并触发点击 */
  triggerDownload(url: string, filename: string): void;
}

export const browserDownloadEnv: DownloadEnv = {
  createObjectURL(blob: Blob): string {
    return URL.createObjectURL(blob);
  },
  revokeObjectURL(url: string): void {
    URL.revokeObjectURL(url);
  },
  triggerDownload(url: string, filename: string): void {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  },
};

/** 下载 Netlist JSON（返回使用的文件名） */
export function downloadNetlist(nl: Netlist, env: DownloadEnv = browserDownloadEnv): string {
  const filename = `circuit-${new Date().toISOString().slice(0, 10)}${ARCHIVE_EXT}`;
  const text = serializeNetlist(nl);
  const blob = new Blob([text], { type: 'application/json' });
  const url = env.createObjectURL(blob);
  env.triggerDownload(url, filename);
  env.revokeObjectURL(url);
  return filename;
}

/** 上传环境抽象：读文件为文本 */
export interface UploadEnv {
  readAsText(file: File): Promise<string>;
}

export const browserUploadEnv: UploadEnv = {
  readAsText(file: File): Promise<string> {
    // 非浏览器环境（如 node 测试）无 FileReader：退回标准 Blob.text()
    if (typeof FileReader === 'undefined') return file.text();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'));
      reader.readAsText(file);
    });
  },
};

export type UploadResult = { ok: true; netlist: Netlist } | { ok: false; error: string };

/** 读取上传文件 → 校验 → Netlist */
export async function uploadNetlist(file: File, env: UploadEnv = browserUploadEnv): Promise<UploadResult> {
  let text: string;
  try {
    text = await env.readAsText(file);
  } catch (e) {
    return { ok: false, error: `读取失败：${e instanceof Error ? e.message : String(e)}` };
  }
  return parseNetlist(text);
}

/* ---------------------------- localStorage 自动保存 ---------------------------- */

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const LS_KEY = 'cir-canvas.autosave';

export const browserStorage: KeyValueStorage = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
  removeItem: (k) => localStorage.removeItem(k),
};

/** 保存到 localStorage（静默失败：隐私模式等） */
export function saveLocal(nl: Netlist, storage: KeyValueStorage = browserStorage): boolean {
  try {
    storage.setItem(LS_KEY, serializeNetlist(nl));
    return true;
  } catch {
    return false;
  }
}

export function loadLocal(storage: KeyValueStorage = browserStorage): Netlist | null {
  try {
    const text = storage.getItem(LS_KEY);
    if (text === null) return null;
    const r = parseNetlist(text);
    return r.ok ? r.netlist : null;
  } catch {
    return null;
  }
}

export function clearLocal(storage: KeyValueStorage = browserStorage): void {
  try {
    storage.removeItem(LS_KEY);
  } catch {
    /* 忽略 */
  }
}
