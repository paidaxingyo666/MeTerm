// 文件上传模块：纯函数和可参数化的上传辅助逻辑

import { readDir } from '@tauri-apps/plugin-fs';
import { encodeMessage } from './file-utils';
import {
  MsgFileOperation,
  type FileOperationRequest,
} from './protocol';

/** 上传 pipeline 常量 */
export const PIPELINE_MAX = 32;
export const SLOW_START_THRESHOLD = 16;
/** 上传 pipeline 状态 */
export interface PipelineState {
  inFlightChunks: number;
  pipelineSize: number;
  pipelineAckCount: number;
}

/**
 * TCP 风格自适应 pipeline：慢启动 + 线性拥塞避免
 * 返回更新后的 pipeline 状态
 */
export function adaptPipeline(state: PipelineState): PipelineState {
  let { pipelineSize, pipelineAckCount } = state;
  if (pipelineSize < SLOW_START_THRESHOLD) {
    pipelineSize = Math.min(SLOW_START_THRESHOLD, pipelineSize + 1);
  } else {
    pipelineAckCount++;
    if (pipelineAckCount >= pipelineSize) {
      pipelineSize = Math.min(PIPELINE_MAX, pipelineSize + 1);
      pipelineAckCount = 0;
    }
  }
  return { ...state, pipelineSize, pipelineAckCount };
}

/** 发送创建远程目录请求 */
export function sendMkdirRequest(ws: WebSocket, remotePath: string): void {
  const request: FileOperationRequest = { operation: 'mkdir', path: remotePath };
  const message = encodeMessage(MsgFileOperation, new TextEncoder().encode(JSON.stringify(request)));
  ws.send(message);
}

/** 递归收集本地目录下所有文件（纯 Tauri API，无状态依赖） */
export async function collectLocalFiles(
  basePath: string,
  relativePath: string
): Promise<Array<{ localPath: string; relativePath: string }>> {
  const results: Array<{ localPath: string; relativePath: string }> = [];
  const entries = await readDir(basePath);

  for (const entry of entries) {
    const fullPath = basePath.endsWith('/') ? `${basePath}${entry.name}` : `${basePath}/${entry.name}`;
    const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

    if (entry.isDirectory) {
      const subFiles = await collectLocalFiles(fullPath, relPath);
      results.push(...subFiles);
    } else {
      results.push({ localPath: fullPath, relativePath: relPath });
    }
  }

  return results;
}
