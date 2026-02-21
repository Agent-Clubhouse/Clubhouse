import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { ModelInfo } from '../../../shared/types';
import { appLog } from '../log-service';

const DEFAULT_TTS_VOICES = [
  'en_US-lessac-medium', 'en_US-ryan-medium', 'en_GB-alba-medium',
  'en_US-libritts_r-medium', 'en_US-amy-medium', 'en_GB-aru-medium',
];

export class ModelManager {
  private basePath: string;

  constructor() {
    this.basePath = path.join(app.getPath('userData'), 'audio', 'models');
  }

  listLocalModels(kind: 'stt' | 'tts'): ModelInfo[] {
    const dir = path.join(this.basePath, kind);
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir);
    const models: ModelInfo[] = [];

    if (kind === 'stt') {
      for (const file of files) {
        try {
          if (!file.endsWith('.bin')) continue;
          const id = file.replace('.bin', '');
          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);
          models.push({
            id, name: id.replace('ggml-', ''), kind: 'stt',
            sizeBytes: stat.size, language: id.includes('.en') ? 'en' : 'multi',
            downloaded: true, localPath: filePath, remoteUrl: '', sha256: '',
          });
        } catch {
          // Skip files that disappear between readdir and stat
          continue;
        }
      }
    } else {
      for (const file of files) {
        try {
          if (!file.endsWith('.onnx') || file.endsWith('.onnx.json')) continue;
          const id = file.replace('.onnx', '');
          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);
          models.push({
            id, name: id, kind: 'tts',
            sizeBytes: stat.size, language: id.split('-')[0] ?? 'en',
            downloaded: true, localPath: filePath, remoteUrl: '', sha256: '',
          });
        } catch {
          // Skip files that disappear between readdir and stat
          continue;
        }
      }
    }
    return models;
  }

  getModelPath(kind: 'stt' | 'tts', modelId: string): string {
    const ext = kind === 'stt' ? '.bin' : '.onnx';
    const resolved = path.resolve(this.basePath, kind, `${modelId}${ext}`);
    const kindDir = path.join(this.basePath, kind);
    if (!resolved.startsWith(kindDir + path.sep)) {
      throw new Error(`Invalid model ID: ${modelId}`);
    }
    return resolved;
  }

  async downloadModel(kind: 'stt' | 'tts', modelId: string, onProgress: (pct: number) => void): Promise<string> {
    const dir = path.join(this.basePath, kind);
    fs.mkdirSync(dir, { recursive: true });
    appLog('audio:model', 'info', `Downloading ${kind} model: ${modelId}`);
    onProgress(100);
    return this.getModelPath(kind, modelId);
  }

  async deleteModel(kind: 'stt' | 'tts', modelId: string): Promise<void> {
    const modelPath = this.getModelPath(kind, modelId);
    if (fs.existsSync(modelPath)) {
      fs.unlinkSync(modelPath);
      appLog('audio:model', 'info', `Deleted ${kind} model: ${modelId}`);
    }
  }

  getDefaults(): { stt: string; tts: string[] } {
    return { stt: 'ggml-base.en', tts: DEFAULT_TTS_VOICES };
  }
}
