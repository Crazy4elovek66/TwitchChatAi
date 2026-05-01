import { createVoskPythonProvider } from "./voskPythonProvider";

export type STTProvider = {
    start(): Promise<void>;
    reset(): Promise<void>;
    transcribePcm(pcm: Buffer, final?: boolean): Promise<{ text: string; isFinal: boolean; isPartial: boolean }>;
    stop(): void;
};

export function createSTTProvider(log?: (s: string) => void): STTProvider {
    const p = (process.env.STT_PROVIDER ?? "yandex").toLowerCase();
    if (p === "vosk_py" || p === "vosk" || p === "local") return createVoskPythonProvider(log);
    throw new Error(`STT_PROVIDER=${p} is not wired to Yandex here yet. Add your existing Yandex provider or set STT_PROVIDER=vosk_py`);
}
