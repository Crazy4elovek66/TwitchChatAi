import path from 'path';
import { logger } from '../logger';
import { VoskPythonProvider } from '../yandex/stt/voskPythonProvider';

/**
 * Local STT wrapper around the Python Vosk worker.
 *
 * Fixes:
 * - Forces Python stdout/stderr to UTF-8 to avoid "кракозябры" on Windows.
 * - Ensures unbuffered output to reduce latency / stuck reads.
 */
export class VoskSTT {
  private provider: VoskPythonProvider;
  private started = false;

  constructor(
    private modelPath: string,
    private sampleRate: number = Number(process.env.VOSK_SAMPLE_RATE ?? 16000),
  ) {
    const root = process.cwd();

    const defaultPython =
      process.platform === 'win32'
        ? path.join(root, '.venv', 'Scripts', 'python.exe')
        : 'python3';

    const pythonPath = process.env.VOSK_PYTHON ?? defaultPython;
    const workerPath = process.env.VOSK_WORKER ?? path.join(root, 'python', 'vosk_worker.py');

    // --- Encoding / buffering fixes (Windows-friendly) ---
    // Make Python always speak UTF-8, even when Windows console default is cp1251/cp866.
    // Also make output unbuffered (like `python -u`) to reduce latency and avoid partial lines.
    process.env.PYTHONIOENCODING = process.env.PYTHONIOENCODING ?? 'utf-8';
    process.env.PYTHONUTF8 = process.env.PYTHONUTF8 ?? '1';
    process.env.PYTHONUNBUFFERED = process.env.PYTHONUNBUFFERED ?? '1';

    this.provider = new VoskPythonProvider({
      pythonPath,
      workerPath,
      modelPath: this.modelPath,
      sampleRate: this.sampleRate,
      log: (s) => logger.debug(s),
    });
  }

  async init(): Promise<void> {
    if (this.started) return;

    await this.provider.start();
    this.started = true;

    logger.info('Vosk STT initialized');
  }

  /**
   * @param pcm16le 16-bit PCM LE mono buffer at `sampleRate`
   */
  async recognize(pcm16le: Buffer): Promise<string> {
    if (!this.started) await this.init();

    const res = await this.provider.transcribePcm(pcm16le, true);
    return (res.text ?? '').trim();
  }

  async reset(): Promise<void> {
    if (!this.started) return;
    await this.provider.reset();
  }

  stop(): void {
    this.provider.stop();
    this.started = false;
  }
}
