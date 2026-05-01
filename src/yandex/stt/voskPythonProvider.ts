import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import path from "path";
import readline from "readline";

type WorkerMsg =
    | { type: "init"; id: string; model_path: string; sample_rate: number }
    | { type: "reset"; id: string }
    | { type: "transcribe"; id: string; audio_b64: string; final?: boolean };

type WorkerResp =
    | { type: "inited"; id: string; ok: boolean; sample_rate: number }
    | { type: "reset_ok"; id: string; ok: boolean }
    | { type: "result"; id: string | null; text: string; final: boolean; raw?: any }
    | { type: "partial"; id: string | null; text: string; final: false; raw?: any }
    | { type: "error"; id: string | null; error: string; trace?: string };

const makeId = () => `${Date.now()}_${Math.random().toString(16).slice(2)}`;

export class VoskPythonProvider {
    private proc: ChildProcessWithoutNullStreams | null = null;
    private rl: readline.Interface | null = null;
    private pending = new Map<string, (resp: WorkerResp) => void>();

    constructor(
        private opts: { pythonPath: string; workerPath: string; modelPath: string; sampleRate: number; log?: (s: string) => void }
    ) { }

    async start() {
        if (this.proc) return;
        const log = this.opts.log ?? (() => { });
        this.proc = spawn(this.opts.pythonPath, ["-u", this.opts.workerPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        this.proc.stderr.on("data", (d) => log(`[vosk_py:stderr] ${String(d)}`));

        this.rl = readline.createInterface({ input: this.proc.stdout });
        this.rl.on("line", (line) => {
            let msg: WorkerResp;
            try { msg = JSON.parse(line); } catch { return; }
            if (msg.id && this.pending.has(msg.id)) {
                const r = this.pending.get(msg.id)!;
                this.pending.delete(msg.id);
                r(msg);
            }
        });

        const resp = await this.send({ type: "init", id: makeId(), model_path: this.opts.modelPath, sample_rate: this.opts.sampleRate });
        if (resp.type === "error") throw new Error(resp.error);
    }

    async reset() {
        const resp = await this.send({ type: "reset", id: makeId() });
        if (resp.type === "error") throw new Error(resp.error);
    }

    async transcribePcm(pcm: Buffer, final = false) {
        const resp = await this.send({ type: "transcribe", id: makeId(), audio_b64: pcm.toString("base64"), final });
        if (resp.type === "error") throw new Error(resp.error);
        if (resp.type === "partial") return { text: resp.text ?? "", isFinal: false, isPartial: true };
        if (resp.type === "result") return { text: resp.text ?? "", isFinal: resp.final, isPartial: false };
        return { text: "", isFinal: false, isPartial: false };
    }

    stop() {
        try { this.rl?.close(); } catch { }
        try { this.proc?.kill(); } catch { }
        this.pending.clear();
        this.rl = null;
        this.proc = null;
    }

    private send(msg: WorkerMsg): Promise<WorkerResp> {
        if (!this.proc) throw new Error("worker not started");
        return new Promise((resolve) => {
            this.pending.set(msg.id, resolve);
            this.proc!.stdin.write(JSON.stringify(msg) + "\n", "utf8");
        });
    }
}

export function createVoskPythonProvider(log?: (s: string) => void) {
    const root = process.cwd();
    return new VoskPythonProvider({
        pythonPath: process.env.VOSK_PYTHON ?? path.join(root, ".venv", "Scripts", "python.exe"),
        workerPath: process.env.VOSK_WORKER ?? path.join(root, "python", "vosk_worker.py"),
        modelPath: process.env.VOSK_MODEL_PATH ?? path.join(root, "models", "vosk-model-small-ru-0.22"),
        sampleRate: Number(process.env.VOSK_SAMPLE_RATE ?? 16000),
        log,
    });
}
